import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

const PROJECT_DIR_LENGTH_CAP = 200;
const TAIL_BYTES = 64 * 1024;
const CLAUDE_INDEX_TTL_MS = 60_000;
const ROLLOUT_INDEX_TTL_MS = 30_000;
const ROLLOUT_MISS_REBUILD_MS = 5_000;
const ROLLOUT_FILE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
const FILE_HANDLE_PROVIDERS = new Set(["omp", "pi"]);

export interface TranscriptAgent {
  provider: string;
  cwd: string;
  persistence?: {
    sessionId?: string | null;
    nativeHandle?: string | null;
  } | null;
}

export interface TranscriptMessage {
  text: string;
  observedAt: string;
}

interface FileIndex {
  builtAt: number;
  byId: Map<string, string[]>;
}

let claudeIndex: Promise<FileIndex> | null = null;
let rolloutIndex: Promise<FileIndex> | null = null;

export function clearTranscriptCaches(): void {
  claudeIndex = null;
  rolloutIndex = null;
}

function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function pushIndexed(index: Map<string, string[]>, id: string, path: string): void {
  const existing = index.get(id);
  if (existing) {
    if (!existing.includes(path)) existing.push(path);
  } else {
    index.set(id, [path]);
  }
}

function encodeProjectDir(input: string): string {
  const replaced = input.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= PROJECT_DIR_LENGTH_CAP) return replaced;
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${Math.abs(hash).toString(36)}`;
}

function normalizeProjectPath(input: string): string {
  return process.platform === "darwin" ? input.normalize("NFC") : input;
}

async function claudeProjectDirCandidates(cwd: string): Promise<string[]> {
  const root = join(claudeRoot(), "projects");
  const candidates = new Set<string>();
  try {
    candidates.add(join(root, encodeProjectDir(normalizeProjectPath(await realpath(cwd)))));
  } catch {
    // Archived worktree or missing cwd; fall through to the literal path.
  }
  candidates.add(join(root, encodeProjectDir(normalizeProjectPath(cwd))));
  return [...candidates];
}

async function buildClaudeIndex(): Promise<FileIndex> {
  const byId = new Map<string, string[]>();
  const root = join(claudeRoot(), "projects");
  for (const project of await listDirectory(root)) {
    if (!project.isDirectory()) continue;
    const directory = join(root, project.name);
    for (const entry of await listDirectory(directory)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      pushIndexed(byId, entry.name.slice(0, -".jsonl".length), join(directory, entry.name));
    }
  }
  return { builtAt: Date.now(), byId };
}

async function lookupClaudeSession(sessionId: string): Promise<string[]> {
  let index = await (claudeIndex ??= buildClaudeIndex());
  if (Date.now() - index.builtAt > CLAUDE_INDEX_TTL_MS) {
    claudeIndex = buildClaudeIndex();
    index = await claudeIndex;
  }
  return index.byId.get(sessionId) ?? [];
}

async function resolveClaude(agent: TranscriptAgent): Promise<string | null> {
  const sessionId = agent.persistence?.sessionId ?? agent.persistence?.nativeHandle ?? null;
  if (!sessionId) return null;
  for (const directory of await claudeProjectDirCandidates(agent.cwd)) {
    const candidate = join(directory, `${sessionId}.jsonl`);
    if (await isFile(candidate)) return candidate;
  }
  return (await lookupClaudeSession(sessionId))[0] ?? null;
}

async function walkRollouts(root: string, byId: Map<string, string[]>): Promise<void> {
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift() as string;
    for (const entry of await listDirectory(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = ROLLOUT_FILE.exec(entry.name);
      if (match?.[1]) pushIndexed(byId, match[1], path);
    }
  }
}

async function buildRolloutIndex(): Promise<FileIndex> {
  const byId = new Map<string, string[]>();
  await walkRollouts(join(codexHome(), "sessions"), byId);
  await walkRollouts(join(codexHome(), "archived_sessions"), byId);
  return { builtAt: Date.now(), byId };
}

async function resolveCodex(agent: TranscriptAgent): Promise<string | null> {
  const threadId = agent.persistence?.nativeHandle ?? agent.persistence?.sessionId ?? null;
  if (!threadId) return null;
  let index = await (rolloutIndex ??= buildRolloutIndex());
  const age = Date.now() - index.builtAt;
  const miss = !index.byId.has(threadId) && age > ROLLOUT_MISS_REBUILD_MS;
  if (age > ROLLOUT_INDEX_TTL_MS || miss) {
    rolloutIndex = buildRolloutIndex();
    index = await rolloutIndex;
  }
  for (const path of index.byId.get(threadId) ?? []) {
    if (await isFile(path)) return path;
  }
  return null;
}

async function resolveHandle(agent: TranscriptAgent): Promise<string | null> {
  const handle = agent.persistence?.nativeHandle ?? null;
  if (!handle || !isAbsolute(handle) || !basename(handle)) return null;
  if (!(await isFile(handle))) return null;
  return handle;
}

async function resolveTranscriptPath(agent: TranscriptAgent): Promise<string | null> {
  switch (agent.provider) {
    case "claude":
      return resolveClaude(agent);
    case "codex":
      return resolveCodex(agent);
    default:
      return FILE_HANDLE_PROVIDERS.has(agent.provider) ? resolveHandle(agent) : null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const text = asString(part.text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

/** A transcript record classified for the latest turn. */
type TurnRecord =
  | { kind: "message"; message: TranscriptMessage }
  | { kind: "activity" }
  | { kind: "ended" }
  /** `needsEnd`: the provider writes an end record, so a prompt without one is a turn still running. */
  | { kind: "prompt"; observedAt: string; needsEnd: boolean }
  | { kind: "aborted" };

export interface TranscriptTurn {
  /** Last spoken assistant (or provider error) message of the latest turn. */
  message: TranscriptMessage | null;
  /** Start of the latest turn when it produced no output at all. */
  silentSince: string | null;
}

function messageRecord(text: string, timestamp: string | null): TurnRecord {
  if (!text) return { kind: "activity" };
  return { kind: "message", message: { text, observedAt: timestamp ?? new Date().toISOString() } };
}

function promptRecord(text: string, timestamp: string | null): TurnRecord | null {
  const trimmed = text.trim();
  if (!trimmed || /^<(?:command-|local-command-)/.test(trimmed)) return null;
  if (trimmed.startsWith("[Request interrupted")) return { kind: "aborted" };
  return { kind: "prompt", observedAt: timestamp ?? new Date().toISOString(), needsEnd: false };
}

function classifyClaude(record: Record<string, unknown>): TurnRecord | null {
  const timestamp = asString(record.timestamp);
  if (record.type === "assistant" && isRecord(record.message)) {
    return messageRecord(textParts(record.message.content).trim(), timestamp);
  }
  if (record.type === "result" && (record.is_error === true || record.isError === true)) {
    const text = (asString(record.result) ?? asString(record.error) ?? "").trim();
    return text ? messageRecord(text, timestamp) : null;
  }
  if (record.type === "user" && isRecord(record.message) && record.isMeta !== true && record.isCompactSummary !== true) {
    const content = record.message.content;
    if (Array.isArray(content) && content.some((part) => isRecord(part) && part.type === "tool_result")) {
      return { kind: "activity" };
    }
    return promptRecord(textParts(content), timestamp);
  }
  return null;
}

function classifyCodex(record: Record<string, unknown>): TurnRecord | null {
  const timestamp = asString(record.timestamp);
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return null;
  const payloadType = asString(payload.type);
  if (record.type === "response_item") {
    if (payloadType !== "message") return { kind: "activity" };
    if (asString(payload.role) !== "assistant") return null;
    return messageRecord(textParts(payload.content).trim(), timestamp);
  }
  if (record.type !== "event_msg") return null;
  switch (payloadType) {
    case "agent_message": {
      const text = (asString(payload.message) ?? "").trim();
      return text ? messageRecord(text, timestamp) : null;
    }
    case "task_complete": {
      // A quota stop ends the turn with no agent message and the provider error on this record.
      const text = isRecord(payload.error) ? (asString(payload.error.message) ?? "").trim() : "";
      return text ? messageRecord(text, timestamp) : { kind: "ended" };
    }
    case "task_started":
      return { kind: "prompt", observedAt: timestamp ?? new Date().toISOString(), needsEnd: true };
    case "turn_aborted":
      return { kind: "aborted" };
    default:
      return null;
  }
}

function classifyGeneric(record: Record<string, unknown>): TurnRecord | null {
  const timestamp = asString(record.timestamp);
  const message = isRecord(record.message) ? record.message : record;
  const role = asString(message.role) ?? asString(record.role) ?? asString(record.type);
  const text = textParts(message.content ?? message.text ?? record.text);
  if (role === "user") return promptRecord(text, timestamp);
  return role === "assistant" ? messageRecord(text.trim(), timestamp) : null;
}

function classifyRecord(raw: string, provider: string): TurnRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (provider === "claude") return classifyClaude(parsed);
  if (provider === "codex") return classifyCodex(parsed);
  return classifyClaude(parsed) ?? classifyCodex(parsed) ?? classifyGeneric(parsed);
}

async function readTailLines(path: string): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - TAIL_BYTES);
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter((line) => line.trim().length > 0);
  } finally {
    await handle.close();
  }
}

/**
 * The latest turn in the agent's on-disk transcript, scanned back to its prompt; null when there is
 * no readable transcript. Tool calls, reasoning, and interruptions make a turn neither spoken nor silent.
 */
export async function latestTranscriptTurn(agent: TranscriptAgent): Promise<TranscriptTurn | null> {
  const path = await resolveTranscriptPath(agent);
  if (!path) return null;
  const turn: TranscriptTurn = { message: null, silentSince: null };
  try {
    const lines = await readTailLines(path);
    let active = false;
    let ended = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = classifyRecord(lines[index] ?? "", agent.provider);
      if (!record) continue;
      if (record.kind === "message") return { message: record.message, silentSince: null };
      if (record.kind === "activity") active = true;
      else if (record.kind === "ended") ended = true;
      else if (record.kind === "aborted") return turn;
      else {
        const silent = !active && (ended || !record.needsEnd);
        return silent ? { message: null, silentSince: record.observedAt } : turn;
      }
    }
    return turn;
  } catch (error) {
    if (!isMissing(error)) {
      console.error("[chat-resume] could not read transcript", path, error);
    }
    return null;
  }
}
