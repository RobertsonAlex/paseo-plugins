# chat-resume: treat a silent idle turn as quota exhaustion

## Context
Agent 57c29eac (Codex) ran out of quota but went idle with `lastError: null` and no assistant output.
Its rollout ends with `task_complete { last_agent_message: null, error: { message: "You've hit your
usage limit … try again at Sep 19th, 2026 10:11 AM." } }` — a record `extractCodex` ignores, so no
pills appeared. Other providers may end a quota-stopped turn with nothing at all.
Out of scope: client pill UI changes, `error`-status agents (already covered by `lastError`).

## Decisions
- Read Codex `task_complete.error.message` as a transcript message — gives the exact reset time.
- Transcript scan stops at the turn boundary (user prompt / Codex `task_started`): output after it
  decides; reaching the boundary with no output means a silent turn; a turn with only tool calls or
  reasoning is not silent; an interrupted turn (Codex `turn_aborted`, Claude `[Request interrupted`)
  is not silent. Claude meta, tool_result and `<command-…>` user records are not prompts.
- Silent + idle → `exhausted: true, resetAt: null` → **Continue** + **Handover** pills.
- A cached `agent.turn_ended` with non-empty output newer than the prompt overrides a silent
  transcript (guards against transcript flush lag). Without a transcript, a completed turn_ended
  with no timeline activity marks the agent silent.

## Steps
- [x] 1. Transcript tail returns `{ message, silentSince }` with the boundary rules above; Codex
  `task_complete.error` — files: `chat-resume/server/transcript-tail.ts`,
  `chat-resume/server/inspect-usage.test.ts` — verify: `npm test --workspace=chat-resume`
  Note: Codex turns count as silent only after `task_complete` — a survey found an open auto-review turn.
- [x] 2. `inspectAgent` + turn_ended cache use silence — files: `chat-resume/server/inspect-usage.ts`,
  `chat-resume/index.server.ts` — verify: tests + `npm run typecheck --workspace=chat-resume`
- [x] 3. README — files: `chat-resume/README.md`

## Verification
`npm run typecheck`, `npm test --workspace=chat-resume`; server smoke-run `inspectAgents` against agent
57c29eac → exhausted with resetAt 2026-09-19 10:11; `paseo plugin reload chat-resume` is pending
until merged into the installed checkout.

## Open questions
None blocking.
