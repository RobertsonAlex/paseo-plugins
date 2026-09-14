# chat-resume

Adds two composer pills to agents whose latest state is a provider usage-limit / quota
exhaustion — including Claude's "You've hit your monthly spend limit" assistant message,
which leaves the agent idle instead of in `error`.

Pills are offered when that state is the latest provider error **or** the last assistant
line in the transcript, both live and when you reopen the thread later.

- **Continue** sends a follow-up on the same agent. Shown when the parsed renewal time has
  already passed, or when the message has no parseable renewal time.
- **Resume when renewed** creates one heartbeat with `maxRuns: 1`. Shown while the renewal
  time is still in the future. It runs two minutes after renewal and continues the same
  agent. Once that time arrives, the pill becomes **Continue**.
- **Handover** opens a modal with an editable continuation prompt (commands for recovering the
  source chat through the `paseo` CLI) and a choice of the other ready providers and their
  models, preferring Claude, Codex, Cursor, OpenCode, Copilot, and Gemini. The mode is matched by
  permission level (Codex Auto-review → Claude Auto mode, Full Access ↔ Bypass, plan stays plan),
  falling back to the target provider's default; the effort is matched by level. **Send** starts
  a new agent with that prompt **in the same workspace**. It carries the source agent's labels plus
  `chat-resume.source-agent` set to the source agent ID.

`paseo.agents.create({ cwd })` always opens a new workspace; handover therefore uses
`workspaces.ref(id).agents.create` so the new agent stays in the thread you are looking at.
No agent is created until **Send** is pressed.

Provider renewal windows are not currently exposed through the public plugin API. The
plugin reads the latest refreshed agent error and the last transcript assistant message
for the exhaustion state and reset time, including times such as `resets 12am (Europe/Warsaw)`.

## Limitations

- Pills appear when the latest idle or error state is a usage-limit / quota-exhaustion
  message, not for context-window overflows or other failures.
- ACP providers that keep no on-disk transcript are detected only through `lastError`.
- The handover prompt is edited in a plugin modal, not the native composer, and the app stays
  on the source agent after **Send**.

## Install

```bash
paseo plugin add panrafal/paseo-plugins:chat-resume
```

From a checkout:

```bash
npm install
npm run typecheck --workspace=chat-resume
paseo plugin install /absolute/path/to/paseo-plugins/chat-resume
```

After source changes:

```bash
paseo plugin reload chat-resume
```
