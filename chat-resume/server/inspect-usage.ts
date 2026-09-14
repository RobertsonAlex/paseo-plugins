import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { USAGE_NOTICE_MAX_CHARS, usageFromSources, type UsageMatch, type UsageSource } from "../shared/usage";
import { latestTranscriptTurn, type TranscriptTurn } from "./transcript-tail";

const INSPECT_CONCURRENCY = 8;

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
}

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
  };
}

export async function inspectAgent(agent: PaseoAgent): Promise<UsageInspection> {
  const errorText = agent.lastError ?? null;
  const turn = await latestTranscriptTurn(agent);
  const cached = turnOutput.get(agent.id);

  if (turn?.message) {
    const sources: UsageSource[] = [
      { text: turn.message.text, observedAt: turn.message.observedAt, maxChars: USAGE_NOTICE_MAX_CHARS },
    ];
    if (agent.status === "error" && errorText) {
      sources.push({ text: errorText, observedAt: agent.updatedAt });
    }
    return toInspection(agent.id, usageFromSources(sources));
  }

  const sources: UsageSource[] = [];
  if (errorText) sources.push({ text: errorText, observedAt: agent.updatedAt });
  if (cached) sources.push({ ...cached, maxChars: USAGE_NOTICE_MAX_CHARS });
  const match = usageFromSources(sources);
  if (match.exhausted || agent.status !== "idle") return toInspection(agent.id, match);

  // Some providers stop on quota without a word: an idle turn with no output at all counts as exhausted.
  const silent = turn ? isSilentTranscript(turn, cached) : silentTurns.has(agent.id);
  return { agentId: agent.id, exhausted: silent, resetAt: null };
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
  const inspections = await mapPool(input.agentIds, INSPECT_CONCURRENCY, async (agentId) => {
    try {
      const refreshed = await context.paseo.agents.ref(agentId).refresh();
      const agent = refreshed?.agent;
      if (!agent) return { agentId, exhausted: false, resetAt: null };
      return inspectAgent(agent);
    } catch (error) {
      console.error("[chat-resume] could not inspect agent", agentId, error);
      return { agentId, exhausted: false, resetAt: null };
    }
  });
  return { inspections };
}
