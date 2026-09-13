# chat-resume: handover modal instead of draft panel

## Context
Today **Handover** creates an idle agent on the next ready provider, then opens the agent-scoped
"Handover draft" workspace panel (a new tab with a textarea) where the user presses **Start agent**.
Replace this with a modal opened from the pill: an editable continuation prompt, a provider picker
and a model picker. The mode and effort are derived from the source agent. **Send** creates the
agent with the prompt, so it starts running at once, and closes the modal. No idle agent is created
before Send.

Out of scope: the Continue / Resume when renewed pills, server RPCs, usage detection.

## Decisions
- Pill behavior `kind: "popover"` whose `Content` renders `Modal` from
  `@getpaseo/plugin/client/react-native`. That module is used by agents-history, schedule-runs and
  session-usage, and it becomes a sheet on compact layouts. If the modal does not survive the popover
  closing, render the same form inside the popover (step 1 decides).
- Create with `paseo.workspaces.ref(workspaceId).agents.create({ config, prompt, title, labels })`.
  `prompt` maps to `initialPrompt`, so the agent starts running, and the handover stays in the same
  workspace as the source.
- Provider list: enabled, ready providers except the exhausted source provider, ordered by
  `HANDOVER_PROVIDER_ORDER`; `nextReadyProvider` gives the default. Model list: selectable models
  of the chosen provider, preselecting the default.
- Mode = `similarMode(source.currentModeId, …)`, effort = `similarThinkingOption(source effort, model.thinkingOptions)`,
  recomputed whenever the provider or model changes. Both appear as a read-only line
  ("Mode: … · Effort: …"); the user asked for a simple picker.
- Keep `HANDOVER_SOURCE_LABEL` on the created agent so the existing logic still hides the pill once
  a handover exists.
- Delete `client/handover-panel.tsx` and the `addWorkspacePanel` registration.
- Popover `Content` props have no `navigation`, so after Send: toast "Handover started on X" and close.
  No navigation.

## Steps
- [x] 1. (Merged into step 3, verified live: Modal inside popover Content stays open on desktop and compact.) Spike: switch the Handover pill to `kind: "popover"` with a minimal `Content` that renders an
  open `Modal`; reload via a `-dev` install and check whether the modal stays open with an editable
  TextInput. Record the outcome (modal vs inline popover) here. — files: `chat-resume/client/pills.tsx`
  — verify: `npm run typecheck --workspace=chat-resume`, Playwright against the loopback web UI.
- [x] 2. Pure helper `readyHandoverProviders(entries, currentProvider)` (ordered list) in
  `shared/handover.ts`, with `nextReadyProvider` built on it; add tests. — files:
  `chat-resume/shared/handover.ts`, `chat-resume/shared/handover.test.ts` — verify:
  `npm test --workspace=chat-resume`.
- [x] 3. `client/handover-modal.tsx`: loads the source agent and inspection, the provider snapshot
  (`providers.waitForReady({ cwd })`) and models/modes (`listModels`/`listModes` when the snapshot lacks
  them); prompt TextInput prefilled with `buildHandoverPrompt(sourceId)`; provider and model chips
  (horizontal wrap, theme colors); mode/effort line; error text; Cancel / Send, with Send disabled
  while sending or while the prompt is empty. Send creates the agent with the prompt, marks the
  source as handed over, then closes. — files: `chat-resume/client/handover-modal.tsx`, `chat-resume/client/pills.tsx`
  — verify: typecheck.
- [x] 4. Remove `createHandoverAgent`, `HANDOVER_PANEL_ID`, `client/handover-panel.tsx` and the panel
  registration in `index.client.tsx`; update README (Handover bullet, the panel paragraph, the
  Limitations entry). — files: `chat-resume/index.client.tsx`, `chat-resume/client/pills.tsx`,
  `chat-resume/README.md` — verify: `npm run typecheck`.

## Verification
- `npm run typecheck` (all workspaces) and `npm test --workspace=chat-resume`.
- `paseo plugin install <worktree>/chat-resume --id chat-resume-dev`, then on an agent with a quota-exhausted
  message (or one faked through a transcript): press Handover → the modal shows the prompt, providers
  and models; change the provider → the model list and the mode/effort line update; Send → a new agent
  runs in the same workspace with the edited prompt, and the Handover pill disappears. Check desktop and
  compact widths, light and dark. Remove the `-dev` install afterwards.

## Open questions
- Resolved: the source provider is excluded from the list.

## Notes
- Rebased onto local `main` (5 commits ahead of origin) to pick up 9fb63e0: the old plugin-chosen
  subscriptionId made agent seeding fail, so no pills appeared.
- Live check used a temporary uncommitted patch that ignored the existing handover for 462bcaf4. Send not
  pressed (would start a real agent).
