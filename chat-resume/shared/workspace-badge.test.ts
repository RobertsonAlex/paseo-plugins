import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceBadgeStates } from "./workspace-badge";

test("a scheduled resume outranks a quota stop in the same workspace", () => {
  const agents = [
    { id: "a", workspaceId: "w1" },
    { id: "b", workspaceId: "w1" },
    { id: "c", workspaceId: "w2" },
    { id: "d", workspaceId: "w3" },
    { id: "e" },
  ];
  const states = workspaceBadgeStates(agents, new Set(["b", "e"]), new Set(["a", "c"]));
  assert.deepEqual([...states], [["w1", "scheduled"], ["w2", "exhausted"]]);
});
