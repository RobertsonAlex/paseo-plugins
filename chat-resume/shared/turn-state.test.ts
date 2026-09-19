import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTurnTail, type TurnTimelineItem } from "./turn-state";

const prompt: TurnTimelineItem = { type: "user_message", text: "fix the five bugs" };
const said = (text: string): TurnTimelineItem => ({ type: "assistant_message", text });
const tool = (status = "completed"): TurnTimelineItem => ({ type: "tool_call", status });
const thought: TurnTimelineItem = { type: "reasoning", text: "Drafting the report." };

test("a turn that ends with an assistant message is spoken", () => {
  assert.equal(classifyTurnTail([prompt, tool(), said("Done, here is the diff.")]), "spoken");
});

test("thoughts and todos trailing the last message do not unfinish a turn", () => {
  const items = [prompt, tool(), said("Done."), thought, { type: "todo" } as TurnTimelineItem];
  assert.equal(classifyTurnTail(items), "spoken");
});

test("work after the last assistant message means the turn stopped mid-flight", () => {
  const items = [prompt, said("Let me look."), tool(), tool(), thought];
  assert.equal(classifyTurnTail(items), "unfinished");
});

test("a tail of work with no prompt in view is still unfinished", () => {
  assert.equal(classifyTurnTail([tool(), tool("running")]), "unfinished");
});

test("an empty assistant frame carries a tool call, not speech", () => {
  assert.equal(classifyTurnTail([prompt, said("   "), tool()]), "unfinished");
});

test("a cancelled tool call reads as a deliberate interruption", () => {
  assert.equal(classifyTurnTail([prompt, tool(), tool("canceled")]), "aborted");
});

test("a prompt with no work at all is a silent turn", () => {
  assert.equal(classifyTurnTail([said("earlier"), prompt, thought]), "silent");
});

test("a trailing error leaves the quota patterns to decide", () => {
  assert.equal(classifyTurnTail([prompt, tool(), { type: "error", text: "boom" }]), "spoken");
});

test("an empty tail says nothing either way", () => {
  assert.equal(classifyTurnTail([]), "unknown");
});
