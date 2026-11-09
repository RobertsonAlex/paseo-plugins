import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { exhaustedResetAt, usageResetReader } from "./usage-reset";

const SESSION = "2026-11-08T15:00:00.000Z";
const WEEK = "2026-11-12T09:00:00.000Z";

test("exhaustedResetAt takes the latest reset among the provider's exhausted windows", () => {
  const providers = [
    { providerId: "codex", windows: [{ usedPct: 100, resetsAt: "2026-11-08T10:00:00.000Z" }] },
    {
      providerId: "claude",
      windows: [
        { usedPct: 100, resetsAt: SESSION },
        { remainingPct: 0, resetsAt: WEEK },
        { usedPct: 40, resetsAt: "2026-12-01T00:00:00.000Z" },
      ],
    },
  ];
  assert.equal(exhaustedResetAt(providers, "claude"), WEEK);
  assert.equal(exhaustedResetAt(providers.slice(0, 1), "claude"), null);
});

test("exhaustedResetAt is null with nothing exhausted, no reset time, or two exhausted accounts", () => {
  assert.equal(exhaustedResetAt([], "claude"), null);
  assert.equal(exhaustedResetAt([{ providerId: "claude", windows: [{ usedPct: 99, resetsAt: SESSION }] }], "claude"), null);
  assert.equal(exhaustedResetAt([{ providerId: "claude", windows: [{ usedPct: 100, resetsAt: null }] }], "claude"), null);
  assert.equal(exhaustedResetAt([{ providerId: "claude", windows: [{ usedPct: 100, resetsAt: "soon" }] }], "claude"), null);
  const twoAccounts = [
    { providerId: "claude", windows: [{ usedPct: 100, resetsAt: SESSION }] },
    { providerId: "claude", windows: [{ usedPct: 100, resetsAt: WEEK }] },
  ];
  assert.equal(exhaustedResetAt(twoAccounts, "claude"), null);
  // A second account with room left does not make the exhausted one ambiguous.
  assert.equal(exhaustedResetAt([twoAccounts[0]!, { providerId: "claude", windows: [{ usedPct: 10 }] }], "claude"), SESSION);
});

test("usageResetReader lists usage once and reads usage-off or a missing API as no reset", async () => {
  let calls = 0;
  const on = {
    providers: {
      listUsage: async () => {
        calls += 1;
        return { providers: [{ providerId: "claude", windows: [{ usedPct: 100, resetsAt: SESSION }] }] };
      },
    },
  } as unknown as PaseoApi;
  const read = usageResetReader(on);
  assert.equal(await read("claude"), SESSION);
  assert.equal(await read("codex"), null);
  assert.equal(calls, 1);

  const off = {
    providers: { listUsage: async () => Promise.reject(new Error("Usage is off on this host.")) },
  } as unknown as PaseoApi;
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await usageResetReader(off)("claude"), null);
  } finally {
    console.error = originalError;
  }
  assert.equal(await usageResetReader({ providers: {} } as unknown as PaseoApi)("claude"), null);
});
