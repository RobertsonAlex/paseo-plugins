# chat-resume handover: carry permission level and labels

## Context
The Handover modal picks the new agent's mode with `similarMode` (`chat-resume/shared/handover.ts`).
Without an exact id match it takes the first target mode whose plan-ness matches the source. For
Claude that is `default` ("Always Ask"), which is the most restrictive mode. Seen on 2026-09-14:
Codex `auto-review` (696283b0) → Claude handover 70cb2b7f got "Always Ask" instead of "Auto mode".

The handover agent is created with only `chat-resume.source-agent`; the source agent's labels
(e.g. `devflows.*`) are lost.

Out of scope: letting the user pick the mode in the modal; changing effort matching.

## Decisions
- Map modes by permission tier, using the `colorTier` and `icon` that Paseo sends on every mode
  (`planning` / `safe` / `moderate` / `dangerous`) — ids differ per provider, tiers do not.
- Order within a tier: same icon → same id → target default → first. Icons encode the semantics
  (`ShieldCheck` = reviewed approvals: Codex `auto-review` ↔ Claude `auto`; `ShieldOff` = unattended).
- No matching tier → nearest tier, the less permissive one on a tie. No tier data (ACP providers)
  → exact id, then the target default when it is not a planning mode, then the first non-planning mode.
- Source mode metadata: the source provider's snapshot entry, else `agent.availableModes`, else
  `providers.listModes(source.provider)` (errors ignored → id-only matching).
- Labels: `{ ...source.labels, "chat-resume.source-agent": source.id }`. Keep the existing key as
  the "handed over from" label — `pills.tsx` already relies on it and two live agents carry it.

## Steps
- [x] 1. Tier-aware `similarMode` in `chat-resume/shared/handover.ts`, taking the source mode
  catalog; tests in `chat-resume/shared/handover.test.ts` for Codex↔Claude pairs (auto-review→auto,
  auto→auto, full-access↔bypassPermissions, default→auto, plan→plan) and a tierless ACP target —
  verify: `npm test --workspace=chat-resume`
- [x] 2. `chat-resume/client/handover-modal.tsx`: resolve the source mode catalog, pass it to
  `similarMode`; copy source labels into `agents.create` — verify: `npm run typecheck --workspace=chat-resume`
  Note: committed together with step 1 — the new `similarMode` signature breaks the modal until both land.
- [x] 3. README: mode matched by permission level; labels copied plus `chat-resume.source-agent` —
  verify: read `chat-resume/README.md`

## Verification
- `npm run typecheck` (all workspaces) and `npm test --workspace=chat-resume`.
- Install the worktree as `chat-resume-dev`, check `paseo plugin ls` / `paseo plugin logs`, remove it.
- Live Send needs an agent in a quota-exhausted state; if none exists, report that as pending.

## Open questions
- Rename the label key to `chat-resume.handed-over-from`? Would need `pills.tsx` to read both keys. Non-blocking.
