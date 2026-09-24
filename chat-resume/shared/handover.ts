export const HANDOVER_SOURCE_LABEL = "chat-resume.source-agent";

/** Prefer these over ACP catalog fillers when handing over from an exhausted provider. */
export const HANDOVER_PROVIDER_ORDER = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "copilot",
  "gemini",
] as const;

/** Other ready providers: preferred ones first, then catalog order starting after the current one. */
export function readyHandoverProviders<T extends { provider: string; status: string; enabled: boolean }>(
  entries: readonly T[],
  currentProvider: string,
): T[] {
  const ready = entries.filter(
    (entry) => entry.enabled && entry.status === "ready" && entry.provider !== currentProvider,
  );
  const ordered: T[] = [];
  for (const provider of HANDOVER_PROVIDER_ORDER) {
    const match = ready.find((entry) => entry.provider === provider);
    if (match) ordered.push(match);
  }
  const currentIndex = entries.findIndex((entry) => entry.provider === currentProvider);
  for (let offset = 1; offset <= entries.length; offset += 1) {
    const index = currentIndex < 0 ? offset - 1 : (currentIndex + offset) % entries.length;
    const entry = entries[index];
    if (entry && ready.includes(entry) && !ordered.includes(entry)) ordered.push(entry);
  }
  return ordered;
}

export function nextReadyProvider<T extends { provider: string; status: string; enabled: boolean }>(
  entries: readonly T[],
  currentProvider: string,
): T | null {
  return readyHandoverProviders(entries, currentProvider)[0] ?? null;
}

export interface SelectOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export function buildHandoverPrompt(sourceAgentId: string): string {
  return `Continue the work of Paseo agent ${sourceAgentId}. Do not start over.

Recover its context with the Paseo CLI before acting:
- \`paseo inspect ${sourceAgentId} --json\` shows its provider, model, status, and runtime settings.
- \`paseo logs ${sourceAgentId}\` reads its chat and tool timeline.
- \`paseo logs ${sourceAgentId} --tail 200\` focuses on its latest work.

Then inspect the current workspace and diff, identify the unfinished work, continue it, and verify the result.`;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function thinkingRank(option: SelectOption): number | null {
  const value = `${option.id} ${option.label}`.toLowerCase();
  if (/\b(?:off|none|minimal)\b/.test(value)) return 0;
  if (/\blow\b/.test(value)) return 1;
  if (/\b(?:medium|normal|standard)\b/.test(value)) return 2;
  if (/\bhigh\b/.test(value) && !/\b(?:extra|x)[ -]?high\b/.test(value)) return 3;
  if (/\b(?:extra[ -]?high|xhigh|max)\b/.test(value)) return 4;
  if (/\bultra\b/.test(value)) return 5;
  return null;
}

export function similarThinkingOption(
  sourceId: string | null | undefined,
  targetOptions: readonly SelectOption[],
): string | undefined {
  if (targetOptions.length === 0) return undefined;
  const exact = sourceId
    ? targetOptions.find((option) => normalized(option.id) === normalized(sourceId))
    : undefined;
  if (exact) return exact.id;

  const sourceRank = sourceId ? thinkingRank({ id: sourceId, label: sourceId }) : null;
  if (sourceRank !== null) {
    const ranked = targetOptions
      .map((option) => ({ option, rank: thinkingRank(option) }))
      .filter((entry): entry is { option: SelectOption; rank: number } => entry.rank !== null)
      .sort((left, right) => Math.abs(left.rank - sourceRank) - Math.abs(right.rank - sourceRank));
    if (ranked[0]) return ranked[0].option.id;
  }
  return targetOptions.find((option) => option.isDefault)?.id;
}

/** Paseo mode metadata: `colorTier` is planning/safe/moderate/dangerous, `icon` hints the approval style. */
export interface ModeOption extends SelectOption {
  icon?: string;
  colorTier?: string;
}

const PERMISSION_TIERS = ["safe", "moderate", "dangerous"];

function isPlanningMode(mode: ModeOption): boolean {
  return mode.colorTier === "planning" || /plan/i.test(`${mode.id} ${mode.label}`);
}

/** Modes in the permission tier closest to the source's; the less permissive tier wins a tie. */
function nearestTier<T extends ModeOption>(source: ModeOption, modes: readonly T[]): readonly T[] {
  const sourceRank = PERMISSION_TIERS.indexOf(source.colorTier ?? "");
  if (sourceRank < 0) return modes;
  let nearest: T[] = [];
  let nearestDistance = Infinity;
  for (const mode of modes) {
    const rank = PERMISSION_TIERS.indexOf(mode.colorTier ?? "");
    if (rank < 0) continue;
    const distance = Math.abs(rank - sourceRank) * 2 + (rank > sourceRank ? 1 : 0);
    if (distance < nearestDistance) {
      nearest = [mode];
      nearestDistance = distance;
    } else if (distance === nearestDistance) {
      nearest.push(mode);
    }
  }
  return nearest.length > 0 ? nearest : modes;
}

/**
 * Target mode with the source mode's permission level. Mode ids differ per provider, so match by
 * tier first, then icon, id, and the target default. Returns only ids the target offers.
 */
export function similarMode(
  sourceModeId: string | null | undefined,
  sourceModes: readonly ModeOption[],
  targetModes: readonly ModeOption[],
  targetDefaultModeId?: string | null,
): string | undefined {
  if (targetModes.length === 0) return undefined;
  const defaultId = targetDefaultModeId ?? targetModes.find((mode) => mode.isDefault)?.id;
  const targetDefault = targetModes.find((mode) => mode.id === defaultId);
  const source: ModeOption | null = sourceModeId
    ? (sourceModes.find((mode) => mode.id === sourceModeId) ?? { id: sourceModeId, label: sourceModeId })
    : null;

  const pool = source ? targetModes.filter((mode) => isPlanningMode(mode) === isPlanningMode(source)) : [];
  if (!source || pool.length === 0) {
    if (targetDefault && !isPlanningMode(targetDefault)) return targetDefault.id;
    return (targetModes.find((mode) => !isPlanningMode(mode)) ?? targetDefault)?.id;
  }

  const tier = nearestTier(source, pool);
  return (
    (source.icon ? tier.find((mode) => mode.icon === source.icon) : undefined) ??
    tier.find((mode) => normalized(mode.id) === normalized(source.id)) ??
    tier.find((mode) => mode.id === defaultId) ??
    tier[0]
  )?.id;
}
