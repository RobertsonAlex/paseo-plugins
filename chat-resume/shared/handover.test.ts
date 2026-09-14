import assert from "node:assert/strict";
import { test } from "node:test";
import { nextReadyProvider, readyHandoverProviders, similarMode } from "./handover";

const entry = (provider: string, status = "ready", enabled = true) => ({
  provider,
  status,
  enabled,
});

test("prefers Claude/Codex/Cursor over the next catalog row", () => {
  const picked = nextReadyProvider(
    [entry("cursor"), entry("kilo"), entry("claude"), entry("codex")],
    "cursor",
  );
  assert.equal(picked?.provider, "claude");
});

test("skips the exhausted provider and unavailable preferred ones", () => {
  const picked = nextReadyProvider(
    [entry("claude"), entry("codex", "error"), entry("cursor"), entry("kilo")],
    "claude",
  );
  assert.equal(picked?.provider, "cursor");
});

test("falls back to the next ready catalog entry when none of the preferred providers are ready", () => {
  const picked = nextReadyProvider([entry("cursor"), entry("kilo"), entry("amp")], "cursor");
  assert.equal(picked?.provider, "kilo");
});

test("returns null when no other ready provider exists", () => {
  assert.equal(nextReadyProvider([entry("cursor"), entry("kilo", "loading")], "cursor"), null);
});

test("lists preferred providers first, then catalog order after the current provider", () => {
  const listed = readyHandoverProviders(
    [entry("amp"), entry("kilo"), entry("codex"), entry("cursor"), entry("claude"), entry("zed", "error")],
    "cursor",
  );
  assert.deepEqual(
    listed.map((item) => item.provider),
    ["claude", "codex", "amp", "kilo"],
  );
});

const CLAUDE_MODES = [
  { id: "plan", label: "Plan Mode", icon: "ShieldEllipsis", colorTier: "planning" },
  { id: "default", label: "Always Ask", icon: "Shield", colorTier: "safe" },
  { id: "acceptEdits", label: "Accept File Edits", icon: "ShieldPlus", colorTier: "moderate" },
  { id: "auto", label: "Auto mode", icon: "ShieldCheck", colorTier: "moderate" },
  { id: "bypassPermissions", label: "Bypass", icon: "ShieldOff", colorTier: "dangerous" },
];

const CODEX_MODES = [
  { id: "auto", label: "Default Permissions", icon: "Shield", colorTier: "moderate" },
  { id: "auto-review", label: "Auto-review", icon: "ShieldCheck", colorTier: "moderate" },
  { id: "full-access", label: "Full Access", icon: "ShieldOff", colorTier: "dangerous" },
];

const OPENCODE_MODES = [
  { id: "build", label: "Build", icon: "Shield", colorTier: "moderate" },
  { id: "plan", label: "Plan", icon: "ShieldEllipsis", colorTier: "planning" },
];

test("maps Codex modes to the Claude mode with the same permission level", () => {
  const toClaude = (id: string) => similarMode(id, CODEX_MODES, CLAUDE_MODES, "auto");
  assert.equal(toClaude("auto-review"), "auto");
  assert.equal(toClaude("auto"), "auto");
  assert.equal(toClaude("full-access"), "bypassPermissions");
});

test("maps Claude modes to the Codex mode with the same permission level", () => {
  const toCodex = (id: string) => similarMode(id, CLAUDE_MODES, CODEX_MODES, "auto-review");
  assert.equal(toCodex("auto"), "auto-review");
  assert.equal(toCodex("acceptEdits"), "auto-review");
  assert.equal(toCodex("default"), "auto");
  assert.equal(toCodex("bypassPermissions"), "full-access");
});

test("keeps plan mode when the target has one, otherwise uses the non-planning default", () => {
  assert.equal(similarMode("plan", CLAUDE_MODES, OPENCODE_MODES, null), "plan");
  assert.equal(similarMode("plan", CLAUDE_MODES, CODEX_MODES, "auto-review"), "auto-review");
  assert.equal(similarMode("plan", OPENCODE_MODES, CLAUDE_MODES, "auto"), "plan");
});

test("falls back to the target default when modes carry no tiers", () => {
  const acp = [
    { id: "agent", label: "Agent" },
    { id: "plan", label: "Plan" },
    { id: "ask", label: "Ask" },
  ];
  assert.equal(similarMode("auto-review", CODEX_MODES, acp, "ask"), "ask");
  assert.equal(similarMode("auto-review", CODEX_MODES, acp, "default"), "agent");
  assert.equal(similarMode("agent", acp, CLAUDE_MODES, "auto"), "auto");
  assert.equal(similarMode("unknown", [], CLAUDE_MODES, "auto"), "auto");
  assert.equal(similarMode(null, [], CLAUDE_MODES, "plan"), "default");
});
