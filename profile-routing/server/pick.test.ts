import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EFFORT_ENV,
  parseAgentConfig,
  pickFromScript,
  providerLabel,
  testModelScript,
  type RunCommandResult,
} from "./pick";

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
  const config = await pickFromScript({
    script: "unused",
    effort: "min",
    async run(_script, received) {
      env = received;
      return { stdout: '{"provider":"claude/sonnet-5"}', stderr: "", code: 0 };
    },
  });
  assert.equal(env?.EFFORT, "low");
  assert.deepEqual(config, { provider: "claude/sonnet-5" });
});

test("pickFromScript accepts a joined provider or a separate model", async () => {
  const joined = await pickFromScript({
    script: "unused",
    effort: "medium",
    run: run({ stdout: '{"provider":"claude/claude-opus-5","modeId":"auto"}' }),
  });
  assert.deepEqual(joined, { provider: "claude/claude-opus-5", modeId: "auto" });
  const separate = await pickFromScript({
    script: "unused",
    effort: "high",
    run: run({
      stdout:
        '{"provider":"claude","model":"claude-opus-5","modeId":"auto","thinkingOptionId":"high"}',
    }),
  });
  assert.deepEqual(separate, {
    provider: "claude",
    model: "claude-opus-5",
    modeId: "auto",
    thinkingOptionId: "high",
  });
});

test("providerLabel joins a bare provider with its model and leaves joined ones alone", () => {
  assert.equal(providerLabel({ provider: "claude", model: "claude-opus-5" }), "claude/claude-opus-5");
  assert.equal(providerLabel({ provider: "claude/sonnet-5" }), "claude/sonnet-5");
  assert.equal(providerLabel({ provider: "claude" }), "claude");
});

test("pickFromScript keeps the rest of the agent config and drops unknown fields", async () => {
  const config = await pickFromScript({
    script: "unused",
    effort: "high",
    run: run({
      stdout:
        '{"provider":"codex","model":"gpt-5.5","featureValues":{"fast_mode":true},"systemPrompt":"be terse","effort":"high"}',
    }),
  });
  assert.deepEqual(config, {
    provider: "codex",
    model: "gpt-5.5",
    featureValues: { fast_mode: true },
    systemPrompt: "be terse",
  });
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

test("pickFromScript fails when stdout is not JSON", async () => {
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

test("parseAgentConfig requires an object with a provider", () => {
  assert.throws(() => parseAgentConfig({ model: "claude-opus-5" }), /needs a provider/);
  assert.throws(() => parseAgentConfig({ provider: "  " }), /needs a provider/);
  assert.throws(() => parseAgentConfig([]), /must be an agent config object/);
  assert.deepEqual(parseAgentConfig({ provider: "claude/opus-5" }), { provider: "claude/opus-5" });
});

test("a shell script can interpolate $EFFORT", async () => {
  const config = await pickFromScript({
    script: `echo '{"provider":"claude","model":"sonnet-5","thinkingOptionId":"'"$EFFORT"'"}'`,
    effort: "max",
  });
  assert.deepEqual(config, { provider: "claude", model: "sonnet-5", thinkingOptionId: "max" });
});

test("testModelScript reports contract failures without throwing", async () => {
  const missing = await testModelScript("echo '{\"model\":\"opus-5\"}'");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /needs a provider/);
  const ok = await testModelScript(
    `echo '{"provider":"claude","model":"opus-5","thinkingOptionId":"'"$EFFORT"'"}'`,
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.provider, "claude/opus-5");
    assert.equal(ok.config.thinkingOptionId, "medium");
  }
});
