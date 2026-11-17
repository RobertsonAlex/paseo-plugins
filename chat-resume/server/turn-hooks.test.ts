import assert from "node:assert/strict";
import { test } from "node:test";
import { addTurnHooks } from "./turn-hooks";

test("addTurnHooks registers the turn hooks with addHook and stops them", async () => {
  const calls: string[] = [];
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  const server = {
    addHook: (name: string, handler: (event: unknown, context: unknown) => unknown) => {
      calls.push(`addHook:${name}`);
      handlers.set(name, handler);
      return () => calls.push(`stop:${name}`);
    },
  };
  const seen: string[] = [];
  const stop = addTurnHooks(server as never, {
    before: (event: { agent: { id: string } }) => void seen.push(`before:${event.agent.id}`),
    after: (event: { agent: { id: string } }) => void seen.push(`after:${event.agent.id}`),
  } as never);
  assert.deepEqual(calls, ["addHook:agent.turn.before", "addHook:agent.turn.after"]);
  const result = handlers.get("agent.turn.after")?.({ agent: { id: "a" } }, {});
  assert.ok(result instanceof Promise, "addHook handlers must return a promise");
  await result;
  await handlers.get("agent.turn.before")?.({ agent: { id: "b" } }, {});
  assert.deepEqual(seen, ["after:a", "before:b"]);
  stop();
  assert.deepEqual(calls.slice(2), ["stop:agent.turn.before", "stop:agent.turn.after"]);
});
