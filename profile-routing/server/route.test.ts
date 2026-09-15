import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROFILE_LABEL,
  ROUTER_LABEL,
  RouteCanceled,
  RouteFailure,
  delegateTitle,
  routeMessage,
  type CreateAgentCall,
  type DelegateHandle,
  type FinishResult,
  type RoutingPaseo,
} from "./route";

const call: CreateAgentCall = {
  provider: "claude/claude-haiku-4-5",
  thinkingOptionId: "min",
};

const pickOk = async () => call;

const pickNone = async () => {
  throw new Error("Agent Low: no profile has allowance left; Agent Low · Claude resets in 6d");
};

interface FakeOptions {
  workspaceId?: string | null;
  wait?: () => Promise<FinishResult>;
  created?: Array<unknown>;
  archives?: string[];
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
            return { agent: { workspaceId } };
          },
          async archive() {
            archives.push(id);
            return { archivedAt: "2026-09-15T20:00:00.000Z" };
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

test("delegateTitle keeps the first line within 60 characters", () => {
  assert.equal(delegateTitle("agent", "pong"), "agent: pong");
  const long = delegateTitle("agent", "x".repeat(80));
  assert.equal(long.length, 60);
  assert.equal(long.endsWith("…"), true);
});

test("relay idle yields the routing note then the delegate's last message", async () => {
  const created: unknown[] = [];
  const events = await collect(fakePaseo({ created }));
  assert.deepEqual(events, [
    {
      type: "note",
      text: "Routing to agent (claude/claude-haiku-4-5) as delegate-1.",
    },
    { type: "final", text: "pong" },
  ]);
  assert.deepEqual(created, [
    {
      config: {
        provider: "claude/claude-haiku-4-5",
        modeId: undefined,
        thinkingOptionId: "min",
        featureValues: undefined,
      },
      prompt: "Reply with the single word pong.",
      title: "agent: Reply with the single word pong.",
      labels: {
        [ROUTER_LABEL]: "router-1",
        [PROFILE_LABEL]: "agent",
      },
    },
  ]);
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
  const first = await gen.next();
  assert.equal(first.value?.type, "note");
  signal.abort();
  await assert.rejects(() => gen.next(), (error: unknown) => error instanceof RouteCanceled);
  release({ status: "idle", lastMessage: "too late", error: null });
  assert.deepEqual(archives, []);
});

test("handoff archives the router after the delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const archives: string[] = [];
  const note = "Routing to agent (claude/claude-haiku-4-5) as delegate-1.";
  const events = await collect(fakePaseo({ archives }), { mode: "handoff" });
  assert.deepEqual(events, [
    { type: "note", text: note },
    { type: "final", text: note },
  ]);
  assert.deepEqual(archives, []);
  t.mock.timers.tick(3_000);
  await Promise.resolve();
  assert.deepEqual(archives, ["router-1"]);
});

test("detach completes without waiting or archiving", async () => {
  const archives: string[] = [];
  let waited = false;
  const note = "Routing to agent (claude/claude-haiku-4-5) as delegate-1.";
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
  assert.deepEqual(events, [
    { type: "note", text: note },
    { type: "final", text: note },
  ]);
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
