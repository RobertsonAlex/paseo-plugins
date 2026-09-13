import assert from "node:assert/strict";
import { test } from "node:test";
import { nextReadyProvider, readyHandoverProviders } from "./handover";

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
