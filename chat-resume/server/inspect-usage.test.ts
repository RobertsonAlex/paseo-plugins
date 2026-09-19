import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { PaseoAgent } from "@getpaseo/client";
import type { TurnTimelineItem } from "../shared/turn-state";
import { inspectAgent, latestTurnSilent, latestTurnText } from "./inspect-usage";
import { clearTranscriptCaches, latestTranscriptTurn, type TranscriptAgent } from "./transcript-tail";

const CLAUDE_TEXT =
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 12am (Europe/Warsaw)";

const previousClaude = process.env.CLAUDE_CONFIG_DIR;
const previousCodex = process.env.CODEX_HOME;
let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "chat-resume-transcript-"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CODEX_HOME = join(root, "codex");
  clearTranscriptCaches();
});

after(async () => {
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  if (previousCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodex;
  clearTranscriptCaches();
  if (root) await rm(root, { recursive: true, force: true });
});

test("reads the last Claude assistant quota line from a jsonl tail", async () => {
  const directory = join(root, "claude", "projects", "-chat-resume-test-cwd");
  await mkdir(directory, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-10T20:17:44.913Z",
      message: { content: "keep going" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-10T20:18:39.177Z",
      isApiErrorMessage: true,
      message: { content: [{ type: "text", text: CLAUDE_TEXT }] },
    }),
    JSON.stringify({ type: "ai-title", title: "ignore me" }),
  ];
  await writeFile(join(directory, "sess.jsonl"), `${lines.join("\n")}\n`);
  const turn = await latestTranscriptTurn({
    provider: "claude",
    cwd: "/chat-resume-test-cwd",
    persistence: { sessionId: "sess" },
  });
  assert.equal(turn?.message?.text, CLAUDE_TEXT);
  assert.equal(turn?.message?.observedAt, "2026-09-10T20:18:39.177Z");
  assert.equal(turn?.silentSince, null);
});

test("latestTurnText keeps output after the last user message", () => {
  const text = latestTurnText([
    { type: "user_message", text: "first" },
    { type: "assistant_message", text: "working" },
    { type: "user_message", text: "again" },
    { type: "assistant_message", text: CLAUDE_TEXT },
  ]);
  assert.equal(text, CLAUDE_TEXT);
});

async function claudeTurn(name: string, records: unknown[]) {
  const directory = join(root, "claude", "projects", "-chat-resume-test-cwd");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return latestTranscriptTurn({ provider: "claude", cwd: "/chat-resume-test-cwd", persistence: { sessionId: name } });
}

async function codexTurn(threadId: string, payloads: Array<[string, Record<string, unknown>]>) {
  const directory = join(root, "codex", "sessions", "2026", "09", "13");
  await mkdir(directory, { recursive: true });
  const lines = payloads.map(([type, payload], index) =>
    JSON.stringify({ timestamp: `2026-09-13T17:52:${String(index).padStart(2, "0")}.000Z`, type, payload }),
  );
  await writeFile(join(directory, `rollout-2026-09-13T19-52-25-${threadId}.jsonl`), `${lines.join("\n")}\n`);
  clearTranscriptCaches();
  const agent: TranscriptAgent = { provider: "codex", cwd: "/x", persistence: { nativeHandle: threadId } };
  return latestTranscriptTurn(agent);
}

const userPrompt = (timestamp: string, content: unknown) => ({ type: "user", timestamp, message: { role: "user", content } });

test("a Claude turn with no output after the prompt is silent", async () => {
  const turn = await claudeTurn("silent", [
    { type: "assistant", timestamp: "2026-09-10T20:00:00.000Z", message: { content: [{ type: "text", text: "done" }] } },
    userPrompt("2026-09-10T20:17:44.913Z", "keep going"),
    { type: "user", isMeta: true, timestamp: "2026-09-10T20:17:45.000Z", message: { content: "<meta>" } },
  ]);
  assert.deepEqual(turn, { message: null, silentSince: "2026-09-10T20:17:44.913Z" });
});

test("a Claude turn with only tool calls or an interruption is not silent", async () => {
  const tools = await claudeTurn("tools", [
    userPrompt("2026-09-10T20:17:44.913Z", "keep going"),
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } },
    userPrompt("2026-09-10T20:17:46.000Z", [{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
  ]);
  assert.deepEqual(tools, { message: null, silentSince: null });

  const interrupted = await claudeTurn("interrupted", [
    userPrompt("2026-09-10T20:17:44.913Z", "keep going"),
    userPrompt("2026-09-10T20:17:46.000Z", [{ type: "text", text: "[Request interrupted by user]" }]),
  ]);
  assert.deepEqual(interrupted, { message: null, silentSince: null });
});

const CODEX_ERROR =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 10:11 AM.";

test("reads the Codex quota error from task_complete", async () => {
  const turn = await codexTurn("01a09be6-0000-7463-88b0-000000000001", [
    ["event_msg", { type: "task_started" }],
    ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "review" }] }],
    ["event_msg", { type: "token_count", info: null }],
    ["event_msg", { type: "task_complete", last_agent_message: null, error: { message: CODEX_ERROR } }],
  ]);
  assert.equal(turn?.message?.text, CODEX_ERROR);
  assert.equal(turn?.silentSince, null);
});

test("a Codex turn that completes without output is silent, an aborted one is not", async () => {
  const silent = await codexTurn("01a09be6-0000-7463-88b0-000000000002", [
    ["event_msg", { type: "task_started" }],
    ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "review" }] }],
    ["event_msg", { type: "task_complete", last_agent_message: null, error: null }],
  ]);
  assert.deepEqual(silent, { message: null, silentSince: "2026-09-13T17:52:00.000Z" });

  const aborted = await codexTurn("01a09be6-0000-7463-88b0-000000000003", [
    ["event_msg", { type: "task_started" }],
    ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "review" }] }],
    ["event_msg", { type: "turn_aborted", reason: "interrupted" }],
  ]);
  assert.deepEqual(aborted, { message: null, silentSince: null });

  const running = await codexTurn("01a09be6-0000-7463-88b0-000000000005", [
    ["event_msg", { type: "task_started" }],
    ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "review" }] }],
    ["event_msg", { type: "user_message" }],
  ]);
  assert.deepEqual(running, { message: null, silentSince: null });

  const reasoning = await codexTurn("01a09be6-0000-7463-88b0-000000000004", [
    ["event_msg", { type: "task_started" }],
    ["response_item", { type: "reasoning", summary: [] }],
    ["event_msg", { type: "task_complete", last_agent_message: null, error: null }],
  ]);
  assert.deepEqual(reasoning, { message: null, silentSince: null });
});

test("latestTurnSilent needs a user message with no activity after it", () => {
  assert.equal(latestTurnSilent([]), false);
  assert.equal(latestTurnSilent([{ type: "assistant_message", text: "hi" }, { type: "user_message", text: "go" }]), true);
  assert.equal(
    latestTurnSilent([
      { type: "user_message", text: "go" },
      { type: "reasoning", text: "thinking" },
    ]),
    false,
  );
});

function idleAgent(overrides: Record<string, unknown> = {}): PaseoAgent {
  return {
    id: "agent-unfinished",
    provider: "cursor",
    cwd: "/chat-resume-test-missing",
    workspaceId: "wks_1",
    status: "idle",
    updatedAt: "2026-09-19T06:51:30.334Z",
    pendingPermissions: [],
    persistence: { provider: "cursor", sessionId: "no-such-session" },
    labels: {},
    ...overrides,
  } as unknown as PaseoAgent;
}

const workTail: TurnTimelineItem[] = [
  { type: "user_message", text: "fix the bugs" },
  { type: "assistant_message", text: "Looking now." },
  { type: "tool_call", status: "completed" },
  { type: "reasoning", text: "Running the tests." },
];

test("an idle agent whose turn stopped mid-work reads as unfinished", async () => {
  const inspection = await inspectAgent(idleAgent(), async () => workTail);
  assert.deepEqual(inspection, {
    agentId: "agent-unfinished",
    exhausted: false,
    resetAt: null,
    unfinished: true,
  });
});

test("a turn that ended with an assistant message is left alone", async () => {
  const spoken = [...workTail, { type: "assistant_message", text: "All five are fixed." }];
  const inspection = await inspectAgent(idleAgent(), async () => spoken);
  assert.equal(inspection.unfinished, false);
  assert.equal(inspection.exhausted, false);
});

test("a quota stop wins over the unfinished check and never reads the timeline", async () => {
  let reads = 0;
  const inspection = await inspectAgent(
    idleAgent({ lastError: "You've hit your usage limit. Try again in 2 hours." }),
    async () => {
      reads += 1;
      return workTail;
    },
  );
  assert.equal(inspection.exhausted, true);
  assert.equal(inspection.unfinished, false);
  assert.equal(reads, 0);
});

test("an agent waiting on a permission is not treated as stopped", async () => {
  const inspection = await inspectAgent(
    idleAgent({ pendingPermissions: [{ id: "perm_1" }] }),
    async () => workTail,
  );
  assert.equal(inspection.unfinished, false);
});

test("a timeline that cannot be read leaves the agent alone", async () => {
  const inspection = await inspectAgent(idleAgent(), async () => null);
  assert.equal(inspection.unfinished, false);
  assert.equal(inspection.exhausted, false);
});

test("a running agent is never unfinished", async () => {
  const inspection = await inspectAgent(idleAgent({ status: "running" }), async () => workTail);
  assert.equal(inspection.unfinished, false);
});
