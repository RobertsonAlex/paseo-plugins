import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { classifyTurnTail, type TurnTimelineItem } from "../shared/turn-state";
import { USAGE_NOTICE_MAX_CHARS, usageFromSources, type UsageMatch, type UsageSource } from "../shared/usage";
import { latestTranscriptTurn, type TranscriptTurn } from "./transcript-tail";

const INSPECT_CONCURRENCY = 8;
/** Enough tail to reach the prompt of a short turn; a longer one is classified from its work alone. */
const TIMELINE_TAIL_LIMIT = 60;

const TURN_ACTIVITY = new Set<AgentTimelineItem["type"]>([
  "assistant_message",
  "reasoning",
  "tool_call",
  "todo",
  "error",
  "compaction",
]);

export interface UsageInspection {
  agentId: string;
  exhausted: boolean;
  resetAt: string | null;
  /** The turn stopped mid-work rather than on quota. Never true together with `exhausted`. */
  unfinished: boolean;
}

/** Reads the tail of an agent's timeline, newest item last; null when it cannot be read. */
export type TimelineTailReader = (agentId: string) => Promise<readonly TurnTimelineItem[] | null>;

const turnOutput = new Map<string, { text: string; observedAt: string }>();
/** Agents whose last turn ended (no transcript available) with nothing after the user message. */
const silentTurns = new Set<string>();

export function rememberTurnOutput(agentId: string, text: string, observedAt = new Date().toISOString()): void {
  const trimmed = text.trim();
  if (trimmed) turnOutput.set(agentId, { text: trimmed, observedAt });
  else turnOutput.delete(agentId);
}

export function forgetTurnOutput(agentId: string): void {
  turnOutput.delete(agentId);
  silentTurns.delete(agentId);
}

/** True when the timeline's latest user message is followed by no output, tool call, or reasoning. */
export function latestTurnSilent(timeline: readonly AgentTimelineItem[]): boolean {
  let prompted = false;
  let active = false;
  for (const item of timeline) {
    if (item.type === "user_message") {
      prompted = true;
      active = false;
    } else if (TURN_ACTIVITY.has(item.type)) active = true;
  }
  return prompted && !active;
}

export function latestTurnText(timeline: readonly AgentTimelineItem[]): string {
  let output = "";
  for (const item of timeline) {
    if (item.type === "user_message") output = "";
    else if (item.type === "assistant_message") output += item.text;
    else if (item.type === "error") output += item.message;
  }
  return output;
}

export function rememberTurnEnded(event: {
  agent: { id: string };
  outcome: { kind: string; error?: { message: string } };
  timeline: readonly AgentTimelineItem[];
}): void {
  const chunks: string[] = [];
  if (event.outcome.kind === "failed" && event.outcome.error?.message) {
    chunks.push(event.outcome.error.message);
  }
  const output = latestTurnText(event.timeline).trim();
  if (output) chunks.push(output);
  rememberTurnOutput(event.agent.id, chunks.join("\n"));
  if (event.outcome.kind === "completed" && chunks.length === 0 && latestTurnSilent(event.timeline)) {
    silentTurns.add(event.agent.id);
  } else {
    silentTurns.delete(event.agent.id);
  }
}

/** A silent transcript turn, unless the live turn_ended hook saw output after that prompt (flush lag). */
function isSilentTranscript(turn: TranscriptTurn, cached: { observedAt: string } | undefined): boolean {
  if (!turn.silentSince) return false;
  return !cached || Date.parse(cached.observedAt) < Date.parse(turn.silentSince);
}

function toInspection(agentId: string, match: UsageMatch): UsageInspection {
  return {
    agentId,
    exhausted: match.exhausted,
    resetAt: match.resetAt ? match.resetAt.toISOString() : null,
    unfinished: false,
  };
}

function quotaSources(agent: PaseoAgent, turn: TranscriptTurn | null): UsageSource[] {
  const errorText = agent.lastError ?? null;
  if (turn?.message) {
    const sources: UsageSource[] = [
      { text: turn.message.text, observedAt: turn.message.observedAt, maxChars: USAGE_NOTICE_MAX_CHARS },
    ];
    if (agent.status === "error" && errorText) {
      sources.push({ text: errorText, observedAt: agent.updatedAt });
    }
    return sources;
  }

  const sources: UsageSource[] = [];
  if (errorText) sources.push({ text: errorText, observedAt: agent.updatedAt });
  const cached = turnOutput.get(agent.id);
  if (cached) sources.push({ ...cached, maxChars: USAGE_NOTICE_MAX_CHARS });
  return sources;
}

export async function inspectAgent(
  agent: PaseoAgent,
  readTimelineTail?: TimelineTailReader,
): Promise<UsageInspection> {
  const turn = await latestTranscriptTurn(agent);
  const cached = turnOutput.get(agent.id);

  const match = usageFromSources(quotaSources(agent, turn));
  if (match.exhausted || agent.status !== "idle") return toInspection(agent.id, match);

  // Some providers stop on quota without a word: an idle turn with no output at all counts as exhausted.
  if (!turn?.message) {
    const silent = turn ? isSilentTranscript(turn, cached) : silentTurns.has(agent.id);
    if (silent) return { agentId: agent.id, exhausted: true, resetAt: null, unfinished: false };
  }

  // A pending permission keeps the turn open: the agent is waiting for an answer, not stopped.
  if (!readTimelineTail || (agent.pendingPermissions?.length ?? 0) > 0) {
    return toInspection(agent.id, match);
  }

  // The turn may also have stopped mid-work — a daemon restart, a provider exit, a lost machine.
  const state = classifyTurnTail((await readTimelineTail(agent.id)) ?? []);
  if (state === "silent" && !turn?.message && !cached) {
    return { agentId: agent.id, exhausted: true, resetAt: null, unfinished: false };
  }
  return { agentId: agent.id, exhausted: false, resetAt: null, unfinished: state === "unfinished" };
}

function toTurnItem(item: AgentTimelineItem): TurnTimelineItem {
  const record = item as { type: string; text?: unknown; status?: unknown };
  return {
    type: record.type,
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
  };
}

export function timelineTailReader(paseo: PaseoApi): TimelineTailReader {
  return async (agentId) => {
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({
        direction: "tail",
        limit: TIMELINE_TAIL_LIMIT,
        projection: "projected",
      });
      if (page.error) return null;
      return [...page.entries]
        .sort((left, right) => left.seqStart - right.seqStart)
        .map((entry) => toTurnItem(entry.item));
    } catch (error) {
      console.error("[chat-resume] could not read timeline", agentId, error);
      return null;
    }
  };
}

async function mapPool<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return results;
}

export async function inspectAgents(
  input: { agentIds: string[] },
  context: { paseo: PaseoApi },
): Promise<{ inspections: UsageInspection[] }> {
  const readTail = timelineTailReader(context.paseo);
  const inspections = await mapPool(input.agentIds, INSPECT_CONCURRENCY, async (agentId) => {
    try {
      const refreshed = await context.paseo.agents.ref(agentId).refresh();
      const agent = refreshed?.agent;
      if (!agent) return { agentId, exhausted: false, resetAt: null, unfinished: false };
      return inspectAgent(agent, readTail);
    } catch (error) {
      console.error("[chat-resume] could not inspect agent", agentId, error);
      return { agentId, exhausted: false, resetAt: null, unfinished: false };
    }
  });
  return { inspections };
}
