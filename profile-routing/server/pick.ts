import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentConfigSchema, providerLabel, type AgentConfig } from "../shared/agent-call";

export { AgentConfigSchema, providerLabel, type AgentConfig };

const execFileAsync = promisify(execFile);

export const EFFORT_IDS = ["min", "medium", "high", "max"] as const;
export type EffortId = (typeof EFFORT_IDS)[number];

// "agent min" matches no model-pick tier; scripts that interpolate $EFFORT expect low/medium/high/max.
export const EFFORT_ENV: Record<EffortId, string> = {
  min: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

export function parseAgentConfig(value: unknown): AgentConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model script JSON must be an agent config object.");
  }
  const provider = (value as Record<string, unknown>).provider;
  if (typeof provider !== "string" || provider.trim() === "") {
    throw new Error(
      'Model script JSON needs a provider, either "claude/opus-5" or "claude" with a separate model.',
    );
  }
  const config = AgentConfigSchema.safeParse(value);
  if (!config.success) {
    throw new Error(`Model script JSON is not an agent config: ${config.error.message}`);
  }
  return config.data;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export async function runShell(
  script: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<RunCommandResult> {
  try {
    const result = await execFileAsync("/bin/sh", ["-c", script], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failed = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message: string;
    };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? failed.message,
      code: typeof failed.code === "number" ? failed.code : 1,
    };
  }
}

export async function pickFromScript(options: {
  script: string;
  effort: EffortId;
  cwd?: string;
  run?: typeof runShell;
}): Promise<AgentConfig> {
  const result = await (options.run ?? runShell)(
    options.script,
    { ...process.env, EFFORT: EFFORT_ENV[options.effort] },
    options.cwd,
  );
  const output = result.stdout.trim();
  if (result.code !== 0 || output.length === 0) {
    const detail = (result.stderr.trim() || output || `exit ${result.code ?? "unknown"}`).slice(0, 500);
    throw new Error(`Model script failed: ${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`Model script did not print JSON: ${output.slice(0, 200)}`);
  }
  return parseAgentConfig(parsed);
}

export async function testModelScript(script: string): Promise<{
  ok: true;
  config: AgentConfig;
  provider: string;
} | {
  ok: false;
  error: string;
}> {
  try {
    const config = await pickFromScript({ script, effort: "medium" });
    return { ok: true, config, provider: providerLabel(config) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
