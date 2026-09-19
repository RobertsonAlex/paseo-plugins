# chat-resume

Adds composer pills to agents that stopped without finishing: a provider usage-limit / quota
exhaustion — including Claude's "You've hit your monthly spend limit" assistant message,
which leaves the agent idle instead of in `error`.

Pills are offered when that state is the latest provider error **or** the last assistant
line in the transcript, both live and when you reopen the thread later. Codex's quota error is
read from the turn's `task_complete` record, which carries the renewal time.

Some providers stop on quota without any message. An idle agent whose latest turn produced
no output at all after the user message — no text, tool call, or reasoning, and not
interrupted — is treated as quota-exhausted with no known renewal time, so it gets
**Continue** and **Handover**.

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

## Turns that stopped mid-work

An agent can also go idle without finishing its turn and without saying why — the daemon
restarted, the provider process exited, the machine went down. The plugin reads the tail of the
agent's timeline (through the daemon, so it covers every provider, including ACP ones with no
on-disk transcript) and treats a turn as unfinished when tool calls ran after the last thing the
agent said, or when the page shows only work. Trailing thoughts, todo lists, and compactions do
not count as work, since they routinely follow a finished turn.

Such an agent gets a single **Continue** pill (`StepForward`) that asks it to review the
conversation and the workspace state and pick the work back up. There is no **Handover** and no
renewal schedule: nothing about the provider's allowance is known to be wrong. A quota stop
always wins over this check, and an agent with a pending permission request is left alone —
it is waiting for an answer, not stopped.

`paseo.agents.create({ cwd })` always opens a new workspace; handover therefore uses
`workspaces.ref(id).agents.create` so the new agent stays in the thread you are looking at.
No agent is created until **Send** is pressed.

Provider renewal windows are not currently exposed through the public plugin API. The
plugin reads the latest refreshed agent error and the last transcript assistant message
for the exhaustion state and reset time, including times such as `resets 12am (Europe/Warsaw)`.

## Limitations

- Pills appear when the latest idle or error state is a usage-limit / quota-exhaustion
  message, not for context-window overflows or other failures.
- ACP providers that keep no on-disk transcript are read through `lastError`, the live turn-end
  event, and the daemon's timeline tail, which also carries a silent turn across a daemon restart.
- A turn that ends silently for another reason also gets the pills.
- A turn whose last tool call is cancelled reads as a deliberate interruption and gets no
  **Continue**, so a turn cut short by a provider process exit mid-tool is missed.
- A turn that legitimately ends on a tool call without a closing message reads as unfinished.
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
