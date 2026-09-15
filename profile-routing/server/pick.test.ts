import assert from "node:assert/strict";
import { test } from "node:test";
import { EFFORT_ENV, pickFromScript, type RunCommandResult } from "./pick";

function run(result: Partial<RunCommandResult>): () => Promise<RunCommandResult> {
  return async () => ({
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.code ?? 0,
  });
}

test("EFFORT_ENV maps min to low so agent $EFFORT matches a tier", () => {
  assert.equal(EFFORT_ENV.min, "low");
  assert.equal(EFFORT_ENV.medium, "medium");
});

test("pickFromScript sets EFFORT from the thinking option", async () => {
  let env: NodeJS.ProcessEnv | undefined;
  const call = await pickFromScript({
    script: "unused",
    effort: "min",
    async run(_script, received) {
      env = received;
      return { stdout: '{"provider":"claude/sonnet-5"}', stderr: "", code: 0 };
    },
  });
  assert.equal(env?.EFFORT, "low");
  assert.deepEqual(call, { provider: "claude/sonnet-5" });
});

test("pickFromScript strips unknown JSON fields", async () => {
  const call = await pickFromScript({
    script: "unused",
    effort: "high",
    run: run({
      stdout: '{"provider":"claude/sonnet-5","effort":"high","modeId":"auto"}',
    }),
  });
  assert.deepEqual(call, { provider: "claude/sonnet-5", modeId: "auto" });
});

test("pickFromScript fails when the script exits non-zero", async () => {
  await assert.rejects(
    () =>
      pickFromScript({
        script: "unused",
        effort: "min",
        run: run({ code: 1, stderr: "Agent High: no profile has allowance left" }),
      }),
    /Model script failed: Agent High: no profile has allowance left/,
  );
});

test("pickFromScript fails when stdout is not create-agent JSON", async () => {
  await assert.rejects(
    () =>
      pickFromScript({
        script: "unused",
        effort: "min",
        run: run({ stdout: "not json" }),
      }),
    /Model script did not print JSON/,
  );
});

test("a shell script can interpolate $EFFORT", async () => {
  const call = await pickFromScript({
    script: `echo '{"provider":"claude/sonnet-5","thinkingOptionId":"'"$EFFORT"'"}'`,
    effort: "max",
  });
  assert.deepEqual(call, { provider: "claude/sonnet-5", thinkingOptionId: "max" });
});
