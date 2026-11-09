import assert from "node:assert/strict";
import { test } from "node:test";
import { addTurnHooks } from "./turn-hooks";

function fakeServer(withAddHook: boolean) {
  const calls: string[] = [];
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  const register = (api: string) => (name: string, handler: (event: unknown, context: unknown) => unknown) => {
    calls.push(`${api}:${name}`);
    handlers.set(name, handler);
    return () => calls.push(`stop:${name}`);
  };
  const server = { on: register("on"), ...(withAddHook ? { addHook: register("addHook") } : {}) };
  return { server: server as never, calls, handlers };
}

const recorder = () => {
  const seen: string[] = [];
  return {
    seen,
    handlers: {
      before: (event: { agent: { id: string } }) => void seen.push(`before:${event.agent.id}`),
      after: (event: { agent: { id: string } }) => void seen.push(`after:${event.agent.id}`),
    },
  };
};

test("addTurnHooks uses addHook with the 0.15 names when the server has it", async () => {
  const { server, calls, handlers } = fakeServer(true);
  const { seen, handlers: turn } = recorder();
  const stop = addTurnHooks(server, turn as never);
  assert.deepEqual(calls, ["addHook:agent.turn.before", "addHook:agent.turn.after"]);
  const result = handlers.get("agent.turn.after")?.({ agent: { id: "a" } }, {});
  assert.ok(result instanceof Promise, "addHook handlers must return a promise");
  await result;
  assert.deepEqual(seen, ["after:a"]);
  stop();
  assert.deepEqual(calls.slice(2), ["stop:agent.turn.before", "stop:agent.turn.after"]);
});

test("addTurnHooks falls back to on with the 0.14 names", async () => {
  const { server, calls, handlers } = fakeServer(false);
  const { seen, handlers: turn } = recorder();
  const stop = addTurnHooks(server, turn as never);
  assert.deepEqual(calls, ["on:agent.turn_started", "on:agent.turn_ended"]);
  await handlers.get("agent.turn_started")?.({ agent: { id: "b" } }, {});
  assert.deepEqual(seen, ["before:b"]);
  stop();
  assert.deepEqual(calls.slice(2), ["stop:agent.turn_started", "stop:agent.turn_ended"]);
});

test("addTurnHooks registers nothing on a server with neither API", () => {
  const stop = addTurnHooks({} as never, recorder().handlers as never);
  stop();
});
