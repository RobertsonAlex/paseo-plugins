import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROFILE_LABEL,
  ROUTER_LABEL,
  RouteCanceled,
  RouteFailure,
  delegateTitle,
  routingNote,
  routeMessage,
  type AgentConfig,
  type CreateAgentConfig,
  type DelegateHandle,
  type FinishResult,
  type RoutingPaseo,
} from "./route";

const config: AgentConfig = {
  provider: "claude/claude-haiku-4-5",
  thinkingOptionId: "min",
};

const pickOk = async () => config;

const pickNone = async () => {
  throw new Error("Agent Low: no profile has allowance left; Agent Low · Claude resets in 6d");
};

interface FakeOptions {
  workspaceId?: string | null;
  wait?: () => Promise<FinishResult>;
  created?: Array<unknown>;
  archives?: string[];
  runs?: Array<{ agentId: string; text: string; timeoutMs?: number }>;
  archived?: string[];
  gone?: string[];
}

function fakePaseo(options: FakeOptions = {}): RoutingPaseo {
  const workspaceId = options.workspaceId === undefined ? "ws-1" : options.workspaceId;
  const archives = options.archives ?? [];
  const wait =
    options.wait ?? (async () => ({ status: "idle" as const, lastMessage: "pong", error: null }));
  return {
    agents: {
      ref(id) {
        return {
          workspaceId,
          async refresh() {
            if (options.gone?.includes(id)) throw new Error(`Unknown agent: ${id}`);
            return {
              agent: {
                workspaceId,
                archivedAt: options.archived?.includes(id) ? "2026-09-15T20:00:00.000Z" : null,
              },
            };
          },
          async archive() {
            archives.push(id);
            return { archivedAt: "2026-09-15T20:00:00.000Z" };
          },
          async run(text, runOptions) {
            options.runs?.push({ agentId: id, text, timeoutMs: runOptions?.timeoutMs });
            return await wait();
          },
        };
      },
    },
    workspaces: {
      ref(id) {
        assert.equal(id, workspaceId);
        return {
          agents: {
            async create(input) {
              options.created?.push(input);
              const handle: DelegateHandle = {
                id: "delegate-1",
                waitForFinish: () => wait(),
              };
              return handle;
            },
          },
        };
      },
    },
  };
}

async function collect(
  paseo: RoutingPaseo,
  extra: Partial<Parameters<typeof routeMessage>[0]> = {},
) {
  const events = [];
  const gen = routeMessage({
    paseo,
    routerAgentId: "router-1",
    modelId: "agent",
    mode: "relay",
    effort: "min",
    text: "Reply with the single word pong.",
    timeouts: { relayTimeoutMs: 120_000, archiveDelayMs: 3_000 },
    pick: pickOk,
    ...extra,
  });
  for await (const event of gen) events.push(event);
  return events;
}

// The delegate event only tells the caller what to persist; the chat shows notes and finals.
function visible(events: Awaited<ReturnType<typeof collect>>) {
  return events.filter((event) => event.type !== "delegate");
}

const lastDelegate = { delegateId: "delegate-1", provider: "claude/claude-haiku-4-5" };
const routing = {
  type: "note" as const,
  continued: false,
  modelId: "agent",
  provider: "claude/claude-haiku-4-5",
  delegateId: "delegate-1",
};
const continuing = { ...routing, continued: true };

test("delegateTitle keeps the first line within 60 characters", () => {
  assert.equal(delegateTitle("agent", "pong"), "agent: pong");
  const long = delegateTitle("agent", "x".repeat(80));
  assert.equal(long.length, 60);
  assert.equal(long.endsWith("…"), true);
});

test("a separate model is joined into the provider agents.create requires", async () => {
  const created: unknown[] = [];
  const events = await collect(fakePaseo({ created }), {
    pick: async () => ({
      provider: "claude",
      model: "claude-opus-5",
      featureValues: { fast_mode: true },
    }),
  });
  assert.deepEqual(visible(events)[0], {
    ...routing,
    provider: "claude/claude-opus-5",
  });
  const input = created[0] as { config: CreateAgentConfig };
  assert.deepEqual(input.config, {
    provider: "claude/claude-opus-5",
    featureValues: { fast_mode: true },
  });
});

test("a config title names the delegate", async () => {
  const created: unknown[] = [];
  await collect(fakePaseo({ created }), {
    pick: async () => ({ provider: "claude/opus-5", title: "Named by the script" }),
  });
  const input = created[0] as { title: string };
  assert.equal(input.title, "Named by the script");
});

test("relay idle yields the routing note then the delegate's last message", async () => {
  const created: unknown[] = [];
  const events = await collect(fakePaseo({ created }));
  assert.deepEqual(events, [
    { type: "delegate", delegateId: "delegate-1", provider: "claude/claude-haiku-4-5" },
    routing,
    { type: "final", text: "pong" },
  ]);
  assert.deepEqual(created, [
    {
      config: { provider: "claude/claude-haiku-4-5", thinkingOptionId: "min" },
      prompt: "Reply with the single word pong.",
      title: "agent: Reply with the single word pong.",
      labels: {
        [ROUTER_LABEL]: "router-1",
        [PROFILE_LABEL]: "agent",
      },
    },
  ]);
});

test("relay sends to the last delegate when the provider is unchanged", async () => {
  const created: unknown[] = [];
  const runs: Array<{ agentId: string; text: string; timeoutMs?: number }> = [];
  const events = await collect(fakePaseo({ created, runs }), { last: lastDelegate });
  assert.deepEqual(events, [
    continuing,
    { type: "final", text: "pong" },
  ]);
  assert.deepEqual(runs, [
    { agentId: "delegate-1", text: "Reply with the single word pong.", timeoutMs: 120_000 },
  ]);
  assert.deepEqual(created, []);
});

test("relay creates a delegate when the picked provider changed", async () => {
  const created: unknown[] = [];
  const runs: Array<{ agentId: string; text: string }> = [];
  const events = await collect(fakePaseo({ created, runs }), {
    last: { delegateId: "delegate-0", provider: "codex/gpt-5.5" },
  });
  assert.deepEqual(visible(events)[0], routing);
  assert.equal(created.length, 1);
  assert.deepEqual(runs, []);
});

test("relay creates a delegate when the last one is archived or gone", async () => {
  const archivedCreated: unknown[] = [];
  await collect(fakePaseo({ created: archivedCreated, archived: ["delegate-1"] }), {
    last: lastDelegate,
  });
  assert.equal(archivedCreated.length, 1);
  const goneCreated: unknown[] = [];
  await collect(fakePaseo({ created: goneCreated, gone: ["delegate-1"] }), { last: lastDelegate });
  assert.equal(goneCreated.length, 1);
});

test("handoff and detach always create a delegate", async () => {
  for (const mode of ["handoff", "detach"] as const) {
    const created: unknown[] = [];
    const runs: Array<{ agentId: string; text: string }> = [];
    await collect(fakePaseo({ created, runs }), { last: lastDelegate, mode });
    assert.equal(created.length, 1, mode);
    assert.deepEqual(runs, [], mode);
  }
});

test("relay error fails with the delegate error", async () => {
  await assert.rejects(
    () =>
      collect(
        fakePaseo({
          wait: async () => ({ status: "error", lastMessage: null, error: "provider exploded" }),
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof RouteFailure);
      assert.equal(error.message, "provider exploded");
      return true;
    },
  );
});

test("relay permission fails naming the delegate", async () => {
  await assert.rejects(
    () =>
      collect(
        fakePaseo({
          wait: async () => ({ status: "permission", lastMessage: null, error: null }),
        }),
      ),
    /Delegate delegate-1 is waiting for permission and was left running/,
  );
});

test("relay timeout fails naming the delegate", async () => {
  await assert.rejects(
    () =>
      collect(
        fakePaseo({
          wait: async () => ({ status: "timeout", lastMessage: null, error: null }),
        }),
      ),
    /Delegate delegate-1 did not finish within the relay timeout and was left running/,
  );
});

test("relay interrupt cancels without archiving", async () => {
  const archives: string[] = [];
  const signal = new AbortController();
  let release: (result: FinishResult) => void = () => {};
  const wait = () =>
    new Promise<FinishResult>((resolve) => {
      release = resolve;
    });
  const gen = routeMessage({
    paseo: fakePaseo({ archives, wait }),
    routerAgentId: "router-1",
    modelId: "agent",
    mode: "relay",
    effort: "min",
    text: "pong",
    timeouts: { relayTimeoutMs: 120_000, archiveDelayMs: 3_000 },
    pick: pickOk,
    signal: signal.signal,
  });
  assert.equal((await gen.next()).value?.type, "delegate");
  assert.equal((await gen.next()).value?.type, "note");
  signal.abort();
  await assert.rejects(() => gen.next(), (error: unknown) => error instanceof RouteCanceled);
  release({ status: "idle", lastMessage: "too late", error: null });
  assert.deepEqual(archives, []);
});

test("handoff archives the router after the delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const archives: string[] = [];
  const note = routingNote("agent", "claude/claude-haiku-4-5", "delegate-1");
  const events = await collect(fakePaseo({ archives }), { mode: "handoff" });
  assert.deepEqual(visible(events), [routing, { type: "final", text: note }]);
  assert.deepEqual(archives, []);
  t.mock.timers.tick(3_000);
  await Promise.resolve();
  assert.deepEqual(archives, ["router-1"]);
});

test("detach completes without waiting or archiving", async () => {
  const archives: string[] = [];
  let waited = false;
  const note = routingNote("agent", "claude/claude-haiku-4-5", "delegate-1");
  const events = await collect(
    fakePaseo({
      archives,
      wait: async () => {
        waited = true;
        return { status: "idle", lastMessage: "pong", error: null };
      },
    }),
    { mode: "detach" },
  );
  assert.deepEqual(visible(events), [routing, { type: "final", text: note }]);
  assert.equal(waited, false);
  assert.deepEqual(archives, []);
});

test("missing workspace fails the turn", async () => {
  await assert.rejects(
    () => collect(fakePaseo({ workspaceId: null })),
    (error: unknown) => {
      assert.ok(error instanceof RouteFailure);
      assert.equal(error.message, "Router agent has no workspace");
      return true;
    },
  );
});

test("a failed pick fails the turn with that message", async () => {
  await assert.rejects(
    () => collect(fakePaseo(), { pick: pickNone }),
    (error: unknown) => {
      assert.ok(error instanceof RouteFailure);
      assert.equal(
        error.message,
        "Agent Low: no profile has allowance left; Agent Low · Claude resets in 6d",
      );
      return true;
    },
  );
});
