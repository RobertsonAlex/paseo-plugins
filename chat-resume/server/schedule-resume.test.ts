import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONTINUE_PROMPT } from "../shared/usage";
import { cliInvocation, pendingResumeHeartbeats, quoteCmdShimArg } from "./schedule-resume";

const TRICKY_ARGS = [
  CONTINUE_PROMPT,
  'say "hi there" & echo pwned | more',
  "100% done %PATH% !USERNAME! ^caret (x) <y>",
  "C:\\trailing\\",
  'back\\"slash',
  "",
];

test("cliInvocation passes arguments straight through off Windows and for an .exe", () => {
  assert.deepEqual(cliInvocation("paseo", ["a b", '"c"'], "linux"), {
    command: "paseo",
    args: ["a b", '"c"'],
    windowsVerbatimArguments: false,
  });
  assert.equal(cliInvocation("C:\\paseo.exe", ["a b"], "win32").command, "C:\\paseo.exe");
});

test("cliInvocation runs a Windows .cmd shim through cmd with one quoted, escaped argument each", () => {
  const invocation = cliInvocation("paseo", ["heartbeat", "a b"], "win32");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(invocation.args[3], '"paseo ^^^"heartbeat^^^" ^^^"a^^^ b^^^""');
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.equal(quoteCmdShimArg('x"y'), '^^^"x\\^^^"y^^^"');
});

test("a .cmd shim receives every argument intact", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-resume shim (x)-"));
  try {
    await writeFile(join(directory, "echo.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    // Shaped like Paseo's bin\paseo.cmd: forward %* to a node entry.
    await writeFile(join(directory, "echo.cmd"), `@"${process.execPath}" "%~dp0echo.js" %*\r\n`);
    const invocation = cliInvocation(join(directory, "echo.cmd"), TRICKY_ARGS, "win32");
    const result = spawnSync(invocation.command, invocation.args, {
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), TRICKY_ARGS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pendingResumeHeartbeats finds only this plugin's unfinished heartbeats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-resume-schedules-"));
  try {
    const write = (file: string, record: unknown) =>
      writeFile(join(directory, file), typeof record === "string" ? record : JSON.stringify(record));
    await write("a.json", {
      id: "s1",
      name: "chat-resume-agent-1",
      status: "active",
      nextRunAt: "2026-11-08T10:00:00.000Z",
      target: { type: "agent", agentId: "agent-1" },
    });
    await write("b.json", {
      id: "s2",
      name: "chat-resume-agent-1",
      status: "completed",
      target: { type: "agent", agentId: "agent-1" },
    });
    await write("c.json", { id: "s3", name: "nightly", status: "active", target: { type: "agent", agentId: "agent-1" } });
    await write("d.json", { id: "s4", name: "chat-resume-agent-2", status: "active", target: { type: "agent", agentId: "agent-3" } });
    await write("e.json", "{ half-written");
    assert.deepEqual(await pendingResumeHeartbeats(directory), [
      { id: "s1", agentId: "agent-1", nextRunAt: "2026-11-08T10:00:00.000Z" },
    ]);
    assert.deepEqual(await pendingResumeHeartbeats(join(directory, "missing")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
