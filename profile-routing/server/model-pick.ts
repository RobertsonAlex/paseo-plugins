import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const EFFORT_TO_TIER = {
  min: "agent low",
  medium: "agent medium",
  high: "agent high",
  max: "agent max",
} as const;

export type EffortId = keyof typeof EFFORT_TO_TIER;

export function effortToTier(effort: EffortId): string {
  return EFFORT_TO_TIER[effort];
}

const DEFAULT_MODEL_PICK = "~/.agents/skills/model-pick/scripts/api.ts";

const CreateAgentSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
});

const RankedProfileSchema = z.object({
  profile: z.object({ name: z.string() }),
  band: z.enum(["ok", "low", "unknown", "exhausted"]),
  allowance: z.number().nullable(),
  limitingWindow: z.object({ label: z.string(), resetsAt: z.string().nullable() }).nullable(),
});

const PickedTierSchema = z.object({
  tier: z.string(),
  profiles: z.array(
    RankedProfileSchema.extend({ call: z.object({ createAgent: CreateAgentSchema }) }),
  ),
  excluded: z.array(RankedProfileSchema),
});

export type PickedTier = z.infer<typeof PickedTierSchema>;
export type CreateAgentArguments = z.infer<typeof CreateAgentSchema>;

const AgentProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string().min(1),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().optional(),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

const WireUsageWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPct: z.number().nullable().optional(),
  resetsAt: z.string().nullable().optional(),
});

const WireUsageBalanceSchema = z.object({
  id: z.string(),
  label: z.string(),
  used: z.number().nullable().optional(),
  remaining: z.number().nullable().optional(),
  limit: z.number().nullable().optional(),
  unit: z.string(),
});

const WireProviderUsageSchema = z.object({
  providerId: z.string(),
  status: z.enum(["available", "unavailable", "error"]),
  windows: z.array(WireUsageWindowSchema),
  balances: z.array(WireUsageBalanceSchema).optional(),
});

export type WireProviderUsage = z.infer<typeof WireProviderUsageSchema>;

export interface ProviderUsage {
  providerId: string;
  status: "available" | "unavailable" | "error";
  windows: Array<{ id: string; label: string; usedPct: number | null; resetsAt: string | null }>;
  balances: Array<{
    id: string;
    label: string;
    used: number | null;
    remaining: number | null;
    limit: number | null;
    unit: string;
  }>;
}

export function toProviderUsage(wire: WireProviderUsage): ProviderUsage {
  return {
    providerId: wire.providerId,
    status: wire.status,
    windows: wire.windows.map((window) => ({
      id: window.id,
      label: window.label,
      usedPct: window.usedPct ?? null,
      resetsAt: window.resetsAt ?? null,
    })),
    balances: (wire.balances ?? []).map((balance) => ({
      id: balance.id,
      label: balance.label,
      used: balance.used ?? null,
      remaining: balance.remaining ?? null,
      limit: balance.limit ?? null,
      unit: balance.unit,
    })),
  };
}

export type PickProfiles = (input: {
  profiles: AgentProfile[];
  usage: ProviderUsage[];
  tier: string;
}) => unknown;

export interface PickPaseo {
  config: {
    get(): Promise<{ config: { agentProfiles?: unknown } }>;
  };
  providers: {
    listUsage(): Promise<{ providers: unknown }>;
  };
}

export type PickResult =
  | { profile: { name: string }; call: CreateAgentArguments }
  | { none: string };

const EnvSchema = z.object({
  PROFILE_ROUTING_MODEL_PICK: z.string().min(1).optional(),
});

export function expandHome(file: string): string {
  return file.replace(/^~(?=$|[/\\])/, homedir());
}

export function modelPickPath(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = EnvSchema.parse({
    PROFILE_ROUTING_MODEL_PICK: env.PROFILE_ROUTING_MODEL_PICK,
  });
  return expandHome(parsed.PROFILE_ROUTING_MODEL_PICK ?? DEFAULT_MODEL_PICK);
}

export function selectTier(tiers: PickedTier[], query: string): PickedTier {
  // model-pick matches tiers by word prefix, so "Agent" alone would select every Agent tier.
  const [match, ...others] = tiers;
  if (!match || others.length > 0) {
    const names = tiers.map((entry) => `"${entry.tier}"`).join(", ") || "none";
    throw new Error(`Tier "${query}" must match exactly one model-pick tier; matched ${names}`);
  }
  return match;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function noneMessage(tier: PickedTier, now: Date = new Date()): string {
  const prefix = `${tier.tier}: no profile has allowance left`;
  const resets = tier.excluded
    .flatMap((entry) => {
      const at = entry.limitingWindow?.resetsAt;
      if (!at) return [];
      return [{ name: entry.profile.name, at: Date.parse(at) }];
    })
    .sort((a, b) => a.at - b.at)[0];
  if (!resets || !Number.isFinite(resets.at)) return prefix;
  return `${prefix}; ${resets.name} resets in ${formatDuration(resets.at - now.getTime())}`;
}

export async function loadPickProfiles(
  modulePath: string,
  importer: (specifier: string) => Promise<{ pickProfiles?: unknown }> = (specifier) =>
    import(specifier),
): Promise<PickProfiles> {
  const module = await importer(pathToFileURL(modulePath).href);
  const { pickProfiles } = module;
  if (typeof pickProfiles !== "function") {
    throw new Error(`${modulePath} does not export pickProfiles`);
  }
  return pickProfiles as PickProfiles;
}

export async function pickForEffort(
  paseo: PickPaseo,
  effort: EffortId,
  deps: {
    pickProfiles?: PickProfiles;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    load?: typeof loadPickProfiles;
  } = {},
): Promise<PickResult> {
  const query = effortToTier(effort);
  const pickProfiles =
    deps.pickProfiles ??
    (await (deps.load ?? loadPickProfiles)(modelPickPath(deps.env)));
  const { config } = await paseo.config.get();
  const profiles = (Array.isArray(config.agentProfiles) ? config.agentProfiles : []).flatMap(
    (entry) => {
      const parsed = AgentProfileSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    },
  );
  const usagePayload = await paseo.providers.listUsage();
  const usage = z.array(WireProviderUsageSchema).parse(usagePayload.providers).map(toProviderUsage);
  const tiers = z.array(PickedTierSchema).parse(pickProfiles({ profiles, usage, tier: query }));
  const match = selectTier(tiers, query);
  const best = match.profiles[0];
  if (!best) return { none: noneMessage(match, deps.now) };
  return { profile: { name: best.profile.name }, call: best.call.createAgent };
}
