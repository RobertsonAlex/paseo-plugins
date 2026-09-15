import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effortToTier,
  noneMessage,
  pickForEffort,
  selectTier,
  toProviderUsage,
  type PickPaseo,
  type PickProfiles,
  type PickedTier,
} from "./model-pick";

const claudeCall = {
  createAgent: { provider: "claude", model: "claude-haiku-4-5" },
};

function ranked(name: string, resetsAt: string | null = null): PickedTier["excluded"][number] {
  return {
    profile: { name },
    band: "exhausted",
    allowance: 0,
    limitingWindow: resetsAt ? { label: "Weekly", resetsAt } : null,
  };
}

function paseoWith(profiles: unknown[], usage: unknown[]): PickPaseo {
  return {
    config: {
      async get() {
        return { config: { agentProfiles: profiles } };
      },
    },
    providers: {
      async listUsage() {
        return { providers: usage };
      },
    },
  };
}

test("effortToTier maps min to agent low", () => {
  assert.equal(effortToTier("min"), "agent low");
  assert.equal(effortToTier("medium"), "agent medium");
  assert.equal(effortToTier("high"), "agent high");
  assert.equal(effortToTier("max"), "agent max");
});

test("selectTier requires exactly one matched tier", () => {
  const one: PickedTier = { tier: "Agent Low", profiles: [], excluded: [] };
  assert.equal(selectTier([one], "agent low"), one);
  assert.throws(
    () => selectTier([], "agent low"),
    /Tier "agent low" must match exactly one model-pick tier; matched none/,
  );
  assert.throws(
    () =>
      selectTier(
        [
          { tier: "Agent Low", profiles: [], excluded: [] },
          { tier: "Agent Medium", profiles: [], excluded: [] },
        ],
        "agent",
      ),
    /matched "Agent Low", "Agent Medium"/,
  );
});

test("noneMessage names the soonest reset", () => {
  const now = new Date("2026-09-15T20:00:00.000Z");
  const message = noneMessage(
    {
      tier: "Agent High",
      profiles: [],
      excluded: [
        ranked("Agent High · Codex", "2026-09-22T20:00:00.000Z"),
        ranked("Agent High · Claude", "2026-09-21T20:00:00.000Z"),
      ],
    },
    now,
  );
  assert.equal(
    message,
    "Agent High: no profile has allowance left; Agent High · Claude resets in 6d",
  );
});

test("pickForEffort returns the best profile of the mapped tier", async () => {
  const pickProfiles: PickProfiles = ({ tier }) => {
    assert.equal(tier, "agent low");
    return [
      {
        tier: "Agent Low",
        profiles: [
          {
            profile: { name: "Agent Low · Claude" },
            band: "ok",
            allowance: 80,
            limitingWindow: null,
            call: claudeCall,
          },
        ],
        excluded: [],
      },
    ];
  };
  const result = await pickForEffort(
    paseoWith(
      [{ id: "low-claude", name: "Agent Low · Claude", provider: "claude", model: "claude-haiku-4-5" }],
      [
        {
          providerId: "claude",
          status: "available",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 20 }],
        },
      ],
    ),
    "min",
    { pickProfiles },
  );
  assert.deepEqual(result, {
    profile: { name: "Agent Low · Claude" },
    call: claudeCall.createAgent,
  });
});

test("pickForEffort returns the none message when the tier is exhausted", async () => {
  const now = new Date("2026-09-15T20:00:00.000Z");
  const pickProfiles: PickProfiles = () => [
    {
      tier: "Agent High",
      profiles: [],
      excluded: [ranked("Agent High · Claude", "2026-09-21T20:00:00.000Z")],
    },
  ];
  const result = await pickForEffort(paseoWith([], []), "high", { pickProfiles, now });
  assert.deepEqual(result, {
    none: "Agent High: no profile has allowance left; Agent High · Claude resets in 6d",
  });
});

test("toProviderUsage fills optional usage fields with null", () => {
  assert.deepEqual(
    toProviderUsage({
      providerId: "codex",
      status: "available",
      windows: [{ id: "weekly", label: "Weekly" }],
    }),
    {
      providerId: "codex",
      status: "available",
      windows: [{ id: "weekly", label: "Weekly", usedPct: null, resetsAt: null }],
      balances: [],
    },
  );
});
