import type { DatabaseSync } from "node:sqlite";
import { estimateCost } from "../shared/pricing";
import { emptyMetrics, type Bucket, type Metrics, type MetricKey } from "../shared/schema";
import { COUNT_KEYS, type ParsedTranscript } from "./parser";

/** A session read from a provider's SQLite store. `messages` lets the indexer skip empty sessions. */
export interface StoreSession { nativeId: string; parentId: string | null; archived: boolean; bytes: number; messages: number; parsed: ParsedTranscript }
export type StoreReader = (db: DatabaseSync) => StoreSession[];

type SqliteModule = typeof import("node:sqlite");
type Row = Record<string, unknown>;

function loadSqlite(): SqliteModule | null {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== "function") return null;
  try {
    const loaded = getBuiltin.call(process, "node:sqlite") as SqliteModule | undefined;
    return loaded && typeof loaded.DatabaseSync === "function" ? loaded : null;
  } catch { return null; }
}

/** Opens the store read-only and closes it before returning; the provider may be writing to it. */
export function readStore(path: string, read: StoreReader): StoreSession[] {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error("node:sqlite is unavailable");
  const db = new sqlite.DatabaseSync(path, { readOnly: true, timeout: 2_000 });
  try { return read(db); } finally { db.close(); }
}

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const str = (value: unknown): string => typeof value === "string" ? value : "";
/** ISO strings, epoch seconds or epoch milliseconds. */
function iso(value: unknown): string | null {
  let ms = typeof value === "string" ? Date.parse(value) : num(value) ?? NaN;
  if (typeof value === "number" && ms < 1e12) ms *= 1000;
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;
}

/** Both stores record uncached input with disjoint cache reads and writes. */
function usage(model: string, input: number | null, output: number | null, read: number | null, write: number | null, reasoning: number | null): Metrics | null {
  if (input === null && output === null) return null;
  const m = emptyMetrics();
  m.uncachedTokens = input;
  m.cacheReadTokens = read ?? (input === null ? null : 0);
  m.cacheWriteTokens = write ?? (input === null ? null : 0);
  m.inputTokens = input === null ? null : input + (m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0);
  m.outputTokens = output;
  m.reasoningTokens = reasoning;
  m.requests = 1;
  m.estimatedCostUsd = estimateCost(model, m);
  return m;
}

class SessionBuilder {
  private buckets = new Map<string, Bucket>();
  private startedAt: string | null = null;
  private endedAt: string | null = null;
  bytes = 0;
  messages = 0;
  constructor(private countKeys: readonly MetricKey[]) {}

  time(at: string | null): void {
    if (!at) return;
    if (!this.startedAt || at < this.startedAt) this.startedAt = at;
    if (!this.endedAt || at > this.endedAt) this.endedAt = at;
  }
  add(at: string | null, model: string, effort: string | null, metrics: Partial<Metrics>, tool?: string): void {
    const day = at?.slice(0, 10) ?? "unknown";
    const key = JSON.stringify([day, model, effort]);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { day, model, effort, metrics: emptyMetrics(), tools: Object.create(null) as Record<string, number> };
      // Absence of a recorded event is a known zero only for measurements the store records.
      for (const metric of this.countKeys) bucket.metrics[metric] = 0;
      this.buckets.set(key, bucket);
    }
    for (const [metric, value] of Object.entries(metrics) as [MetricKey, number | null | undefined][]) {
      if (typeof value === "number") bucket.metrics[metric] = (bucket.metrics[metric] ?? 0) + value;
    }
    if (tool) bucket.tools[tool] = (bucket.tools[tool] ?? 0) + 1;
  }
  finish(base: Pick<ParsedTranscript, "nativeId" | "parentId" | "cwd" | "title" | "branch">, created: string | null, updated: string | null): ParsedTranscript {
    const buckets = [...this.buckets.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model) || (a.effort ?? "").localeCompare(b.effort ?? ""));
    const warnings = buckets.some((bucket) => bucket.metrics.inputTokens !== null) ? [] : ["No token usage records found; token and cost measurements are unknown."];
    return { ...base, startedAt: this.startedAt ?? created, endedAt: this.endedAt ?? updated ?? created, buckets, warnings };
  }
}

/** OpenCode and its Kilo fork: `session`, `message` and `part` rows with JSON `data`. Only counters and lengths leave SQLite. */
export const readOpenCodeStore: StoreReader = (db) => {
  const columns = new Set((db.prepare("PRAGMA table_info(session)").all() as Row[]).map((column) => str(column.name)));
  const sessions = db.prepare(`SELECT id, parent_id AS parentId, directory, title, time_created AS created, time_updated AS updated,
    ${columns.has("time_archived") ? "time_archived" : "NULL"} AS archived FROM session`).all() as Row[];
  const messages = db.prepare(`SELECT id, session_id AS sessionId, time_created AS created,
    json_extract(data, '$.role') AS role, json_extract(data, '$.parentID') AS parentId,
    coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID')) AS model,
    json_extract(data, '$.tokens.input') AS input, json_extract(data, '$.tokens.output') AS output,
    json_extract(data, '$.tokens.reasoning') AS reasoning, json_extract(data, '$.tokens.cache.read') AS cacheRead,
    json_extract(data, '$.tokens.cache.write') AS cacheWrite, json_extract(data, '$.cost') AS cost,
    json_extract(data, '$.time.completed') AS completed, length(CAST(data AS BLOB)) AS bytes
    FROM message ORDER BY time_created, id`).all() as Row[];
  const parts = db.prepare(`SELECT message_id AS messageId, json_extract(data, '$.type') AS type, json_extract(data, '$.tool') AS tool,
    json_extract(data, '$.state.status') AS status, length(json_extract(data, '$.text')) AS textLength,
    length(json_extract(data, '$.state.input')) AS inputLength,
    length(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error'))) AS outputLength,
    length(CAST(data AS BLOB)) AS bytes FROM part`).all() as Row[];

  const builders = new Map(sessions.map((row) => [str(row.id), new SessionBuilder(COUNT_KEYS)]));
  const byMessage = new Map<string, { builder: SessionBuilder; at: string | null; model: string; role: string }>();
  const turns = new Map<string, { builder: SessionBuilder; start: number; end: number | null; model: string }>();
  for (const message of messages) {
    const builder = builders.get(str(message.sessionId));
    if (!builder) continue;
    const at = iso(message.created);
    const role = str(message.role);
    const model = str(message.model) || "unknown";
    builder.time(at);
    builder.time(iso(message.completed));
    builder.bytes += num(message.bytes) ?? 0;
    byMessage.set(str(message.id), { builder, at, model, role });
    if (role === "user") {
      builder.messages++;
      builder.add(at, model, null, { userMessages: 1 });
      const start = num(message.created);
      if (start !== null) turns.set(str(message.id), { builder, start, end: null, model });
    }
    if (role === "assistant") {
      builder.messages++;
      // OpenCode records reasoning separately from output; normalized output includes it.
      const output = num(message.output), reasoning = num(message.reasoning);
      const tokens = usage(model, num(message.input), output === null ? null : output + (reasoning ?? 0), num(message.cacheRead), num(message.cacheWrite), reasoning);
      const recorded = tokens && (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0) > 0;
      builder.add(at, model, null, { ...(recorded ? tokens : {}), assistantMessages: 1, reportedCostUsd: num(message.cost) });
      // A turn runs from the user message to its last completed reply.
      const turn = turns.get(str(message.parentId));
      const completed = num(message.completed);
      if (turn && completed !== null) { turn.end = Math.max(turn.end ?? 0, completed); turn.model = model; }
    }
  }
  for (const turn of turns.values()) {
    if (turn.end !== null && turn.end >= turn.start) turn.builder.add(iso(turn.end), turn.model, null, { activeMs: turn.end - turn.start });
  }
  for (const part of parts) {
    const message = byMessage.get(str(part.messageId));
    if (!message) continue;
    const { builder, at, model, role } = message;
    builder.bytes += num(part.bytes) ?? 0;
    if (part.type === "text" && role === "user") builder.add(at, model, null, { userCharacters: num(part.textLength) ?? 0 });
    if (part.type === "text" && role === "assistant") builder.add(at, model, null, { assistantCharacters: num(part.textLength) ?? 0 });
    if (part.type === "tool") builder.add(at, model, null, { toolCalls: 1, toolErrors: part.status === "error" ? 1 : 0, toolInputCharacters: num(part.inputLength) ?? 0, toolOutputCharacters: num(part.outputLength) ?? 0 }, str(part.tool) || "unknown");
    if (part.type === "compaction") builder.add(at, model, null, { compactions: 1 });
  }
  return sessions.map((row) => {
    const builder = builders.get(str(row.id))!;
    const base = { nativeId: str(row.id), parentId: str(row.parentId) || null, cwd: str(row.directory), title: str(row.title).slice(0, 300), branch: "" };
    return { nativeId: base.nativeId, parentId: base.parentId, archived: row.archived !== null && row.archived !== undefined, bytes: builder.bytes, messages: builder.messages, parsed: builder.finish(base, iso(row.created), iso(row.updated)) };
  });
};

const DEVIN_COUNT_KEYS = COUNT_KEYS.filter((key) => key !== "compactions");
const EFFORT_SUFFIX = /^(.+)-(none|minimal|low|medium|high|xhigh|max)$/;
/** Devin CLI: a message forest per session. Compaction copies nodes, so messages and calls are deduplicated by ID. */
export const readDevinStore: StoreReader = (db) => {
  const sessions = db.prepare("SELECT id, working_directory AS cwd, title, created_at AS created, last_activity_at AS updated FROM sessions").all() as Row[];
  const nodes = db.prepare(`SELECT row_id AS rowId, session_id AS sessionId, created_at AS stored,
    json_extract(chat_message, '$.message_id') AS id, json_extract(chat_message, '$.role') AS role,
    json_extract(chat_message, '$.metadata.created_at') AS created,
    json_extract(chat_message, '$.metadata.generation_model') AS model,
    json_extract(chat_message, '$.metadata.telemetry.source') AS source,
    json_extract(chat_message, '$.metadata.metrics.input_tokens') AS input,
    json_extract(chat_message, '$.metadata.metrics.output_tokens') AS output,
    json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS cacheRead,
    json_extract(chat_message, '$.metadata.metrics.cache_creation_tokens') AS cacheWrite,
    json_extract(chat_message, '$.metadata.extensions."chisel/tool_result_meta".success') AS success,
    length(json_extract(chat_message, '$.content')) AS contentLength,
    length(CAST(chat_message AS BLOB)) AS bytes
    FROM message_nodes ORDER BY row_id`).all() as Row[];
  const calls = db.prepare(`SELECT n.session_id AS sessionId, json_extract(n.chat_message, '$.message_id') AS messageId,
    json_extract(t.value, '$.id') AS id, json_extract(t.value, '$.name') AS name, length(json_extract(t.value, '$.arguments')) AS inputLength
    FROM message_nodes n, json_each(n.chat_message, '$.tool_calls') t`).all() as Row[];

  const builders = new Map(sessions.map((row) => [str(row.id), new SessionBuilder(DEVIN_COUNT_KEYS)]));
  const contexts = new Map<string, { at: string | null; model: string; effort: string | null }>();
  const seen = new Set<string>();
  for (const node of nodes) {
    const sessionId = str(node.sessionId);
    const builder = builders.get(sessionId);
    if (!builder) continue;
    builder.bytes += num(node.bytes) ?? 0;
    const key = `${sessionId} ${str(node.id) || `row:${node.rowId}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = iso(node.created) ?? iso(node.stored);
    const context = { ...(contexts.get(sessionId) ?? { model: "unknown", effort: null }), at };
    builder.time(at);
    if (node.role === "assistant") {
      // Generation models carry the effort level as a suffix, e.g. "gpt-6-astra-medium".
      const model = str(node.model), match = EFFORT_SUFFIX.exec(model);
      if (model) { context.model = match ? match[1] : model; context.effort = match ? match[2] : null; }
      builder.messages++;
      const tokens = usage(context.model, num(node.input), num(node.output), num(node.cacheRead), num(node.cacheWrite), null);
      builder.add(at, context.model, context.effort, { ...tokens, assistantMessages: 1, assistantCharacters: num(node.contentLength) ?? 0 });
    }
    // Keepalive pings refresh the prompt cache; they are not user messages.
    if (node.role === "user" && node.source !== "cache_keepalive") {
      builder.messages++;
      builder.add(at, context.model, context.effort, { userMessages: 1, userCharacters: num(node.contentLength) ?? 0 });
    }
    if (node.role === "tool") builder.add(at, context.model, context.effort, { toolOutputCharacters: num(node.contentLength) ?? 0, toolErrors: node.success === 0 ? 1 : 0 });
    contexts.set(sessionId, context);
    contexts.set(key, context);
  }
  const seenCalls = new Set<string>();
  for (const call of calls) {
    const sessionId = str(call.sessionId);
    const builder = builders.get(sessionId);
    const key = `${sessionId} ${str(call.id) || `${str(call.messageId)}:${str(call.name)}`}`;
    if (!builder || seenCalls.has(key)) continue;
    seenCalls.add(key);
    const context = contexts.get(`${sessionId} ${str(call.messageId)}`);
    builder.add(context?.at ?? null, context?.model ?? "unknown", context?.effort ?? null, { toolCalls: 1, toolInputCharacters: num(call.inputLength) ?? 0 }, str(call.name) || "unknown");
  }
  return sessions.map((row) => {
    const builder = builders.get(str(row.id))!;
    const base = { nativeId: str(row.id), parentId: null, cwd: str(row.cwd), title: str(row.title).slice(0, 300), branch: "" };
    return { nativeId: base.nativeId, parentId: null, archived: false, bytes: builder.bytes, messages: builder.messages, parsed: builder.finish(base, iso(row.created), iso(row.updated)) };
  });
};
