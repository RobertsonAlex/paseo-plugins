/**
 * Structural view of an agent timeline item. The plugin reads only `type`, `name`, `detail`,
 * `metadata`, and `text`, so it does not import the protocol package: the daemon resolves type
 * imports from the plugin directory at install time, and a checkout has no `node_modules`.
 */
export interface TimelineItemLike {
  type: string;
  [key: string]: unknown;
}

export interface AvailableSkill {
  name: string;
  description: string;
  argumentHint: string;
}

/** One observed skill use in the agent's timeline. */
export interface SkillUse {
  name: string;
  at: string;
  /**
   * `tool` uses are unambiguous loads (a Skill tool call or a Read of a SKILL.md file) and always
   * count. `command` uses are SKILL.md paths inside shell commands or opaque tool input, and
   * `message` uses are `/name` or `$name` mentions in a prompt. Both count only when the name is an
   * available skill, so scripts that merely quote a path and ordinary `$VARS` are ignored.
   */
  source: "tool" | "command" | "message";
}

export interface UsedSkill {
  name: string;
  count: number;
  lastUsedAt: string;
}

export type SkillScope = "user" | "project" | "project-local" | "plugin" | "builtin";

export interface SkillRow {
  name: string;
  description: string;
  argumentHint: string;
  available: boolean;
  used: boolean;
  useCount: number;
  lastUsedAt: string | null;
  /** Null until the daemon has reported where skills live. */
  scope: SkillScope | null;
}

export interface SkillGroups {
  used: SkillRow[];
  all: SkillRow[];
}

export interface TimelineEntryLike {
  item: TimelineItemLike;
  timestamp: string;
}

/**
 * A skill file is always `<...>/skills/<name>/SKILL.md`, for user, project, Codex, and Claude
 * plugin locations alike. Requiring the `skills` segment and a plain directory name keeps
 * regex-like shell text (`[^/]+)[/\\]SKILL\.md`) from producing phantom skills.
 */
const SKILL_FILE = /(?:^|[^\w.-])skills[/\\]([A-Za-z0-9][\w.-]*)[/\\]SKILL\.md(?![\w.])/g;
const SLASH_COMMAND = /^\s*\/([A-Za-z0-9][\w:.-]*)/;
const DOLLAR_MENTION = /(?:^|[\s(])\$([A-Za-z][\w-]*)/g;
/** Provider skill names: directory-like, optionally `plugin:skill`. */
const SKILL_NAME = /^[A-Za-z0-9_][\w.-]*(?::[A-Za-z0-9_][\w.-]*)*$/;

export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function skillFileNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(SKILL_FILE)) {
    const name = match[1];
    if (name && name !== "." && name !== "..") names.push(name);
  }
  return names;
}

/**
 * The part of a shell command that runs, without heredoc bodies. Agents often write scripts or
 * files through heredocs, and their contents quote SKILL.md paths without reading them.
 */
export function shellCommandHead(command: string): string {
  const lines = command.split(/\r?\n/);
  const kept: string[] = [];
  let terminator: string | null = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    kept.push(line);
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (heredoc?.[2]) terminator = heredoc[2];
  }
  return kept.join("\n");
}

function toolCallUses(item: TimelineItemLike): { names: string[]; source: SkillUse["source"] }[] {
  const groups: { names: string[]; source: SkillUse["source"] }[] = [];
  const names: string[] = [];
  const commandNames: string[] = [];
  const detail = isRecord(item.detail) ? item.detail : {};
  const detailType = asString(detail.type);
  const toolName = asString(item.name) ?? "";
  if (toolName.toLowerCase() === "skill") {
    const label = detailType === "plain_text" ? asString(detail.label) : null;
    const fromInput =
      detailType === "unknown" && isRecord(detail.input) ? asString(detail.input.skill) : null;
    const fromMetadata = isRecord(item.metadata) ? asString(item.metadata.skill) : null;
    const name = label ?? fromInput ?? fromMetadata;
    if (name) names.push(name);
  }
  switch (detailType) {
    case "read":
      names.push(...skillFileNames(asString(detail.filePath) ?? ""));
      break;
    case "shell":
      commandNames.push(...skillFileNames(shellCommandHead(asString(detail.command) ?? "")));
      break;
    case "unknown": {
      let serialized = "";
      try {
        serialized = JSON.stringify(detail.input) ?? "";
      } catch {
        serialized = "";
      }
      commandNames.push(...skillFileNames(serialized));
      break;
    }
    default:
      break;
  }
  groups.push({ names, source: "tool" }, { names: commandNames, source: "command" });
  return groups;
}

function userMessageNames(text: string): string[] {
  const names: string[] = [];
  const slash = SLASH_COMMAND.exec(text);
  if (slash?.[1]) names.push(slash[1]);
  for (const match of text.matchAll(DOLLAR_MENTION)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

/** Skill uses recorded by one timeline item, deduplicated by name (strongest source wins). */
export function detectSkillUses(item: TimelineItemLike, at: string): SkillUse[] {
  let groups: { names: string[]; source: SkillUse["source"] }[] = [];
  if (item.type === "tool_call") {
    groups = toolCallUses(item);
  } else if (item.type === "user_message") {
    groups = [{ names: userMessageNames(asString(item.text) ?? ""), source: "message" }];
  }
  const seen = new Set<string>();
  const uses: SkillUse[] = [];
  for (const group of groups) {
    for (const name of group.names) {
      if (seen.has(name) || !isSkillName(name)) continue;
      seen.add(name);
      uses.push({ name, at, source: group.source });
    }
  }
  return uses;
}

export function scanTimelineEntries(entries: readonly TimelineEntryLike[]): SkillUse[] {
  const uses: SkillUse[] = [];
  for (const entry of entries) uses.push(...detectSkillUses(entry.item, entry.timestamp));
  return uses;
}

/** Folds observed uses into one record per skill, dropping indirect mentions of unknown names. */
export function aggregateSkillUses(
  uses: readonly SkillUse[],
  availableNames: ReadonlySet<string>,
): Map<string, UsedSkill> {
  const used = new Map<string, UsedSkill>();
  for (const use of uses) {
    if (use.source !== "tool" && !availableNames.has(use.name)) continue;
    const existing = used.get(use.name);
    if (existing) {
      existing.count += 1;
      if (use.at > existing.lastUsedAt) existing.lastUsedAt = use.at;
    } else {
      used.set(use.name, { name: use.name, count: 1, lastUsedAt: use.at });
    }
  }
  return used;
}

export function listSkills(
  commands: readonly { name: string; description: string; argumentHint: string; kind?: string }[],
): AvailableSkill[] {
  const byName = new Map<string, AvailableSkill>();
  for (const command of commands) {
    if (command.kind !== undefined && command.kind !== "skill") continue;
    if (!command.name || byName.has(command.name)) continue;
    byName.set(command.name, {
      name: command.name,
      description: command.description ?? "",
      argumentHint: command.argumentHint ?? "",
    });
  }
  return [...byName.values()];
}

export function compareSkillNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base", numeric: true }) || left.localeCompare(right);
}

function matchesQuery(row: SkillRow, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${row.name}\n${row.description}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Classifies a skill from the daemon's on-disk lookup. Names the lookup did not find are Claude
 * plugin skills when they carry a `plugin:skill` prefix and provider built-ins otherwise.
 */
export function resolveSkillScope(
  name: string,
  found: Readonly<Record<string, { scope: SkillScope }>> | null,
): SkillScope | null {
  if (!found) return null;
  const located = found[name];
  if (located) return located.scope;
  return name.includes(":") ? "plugin" : "builtin";
}

/**
 * Builds the two lists shown in the popover: skills used in this chat first, then every
 * available skill, both sorted by name and filtered by the search query.
 */
export function buildSkillGroups(input: {
  available: readonly AvailableSkill[];
  uses: readonly SkillUse[];
  query: string;
  scopes?: Readonly<Record<string, { scope: SkillScope }>> | null;
}): SkillGroups {
  const availableNames = new Set(input.available.map((skill) => skill.name));
  const used = aggregateSkillUses(input.uses, availableNames);
  const scopes = input.scopes ?? null;
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  const all = input.available
    .map((skill): SkillRow => {
      const use = used.get(skill.name);
      return {
        name: skill.name,
        description: skill.description,
        argumentHint: skill.argumentHint,
        available: true,
        used: Boolean(use),
        useCount: use?.count ?? 0,
        lastUsedAt: use?.lastUsedAt ?? null,
        scope: resolveSkillScope(skill.name, scopes),
      };
    })
    .sort((left, right) => compareSkillNames(left.name, right.name));

  const byName = new Map(all.map((row) => [row.name, row] as const));
  const usedRows = [...used.values()]
    .map(
      (use): SkillRow =>
        byName.get(use.name) ?? {
          name: use.name,
          description: "",
          argumentHint: "",
          available: false,
          used: true,
          useCount: use.count,
          lastUsedAt: use.lastUsedAt,
          scope: resolveSkillScope(use.name, scopes),
        },
    )
    .sort((left, right) => compareSkillNames(left.name, right.name));

  return {
    used: usedRows.filter((row) => matchesQuery(row, terms)),
    all: all.filter((row) => matchesQuery(row, terms)),
  };
}

/** Text placed in the composer when a skill is picked. */
export function skillMention(name: string): string {
  return `/${name}`;
}
