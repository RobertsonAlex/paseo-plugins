import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { CONTINUE_PROMPT, resumeAction } from "../shared/usage";
import { inspectAgent } from "./inspect-usage";
import { usageResetReader } from "./usage-reset";

const GRACE_MS = 2 * 60_000;
const MIN_DELAY_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 12_000;

interface ScheduleResult {
  scheduleId: string;
  scheduledFor: string;
}

interface ScheduleRow {
  id: string;
  nextRunAt?: string | null;
}

export interface ResumeHeartbeat {
  id: string;
  agentId: string;
  nextRunAt: string | null;
}

const pendingByAgent = new Map<string, Promise<ScheduleResult>>();
const HEARTBEAT_PREFIX = "chat-resume-";

function scheduleDirectory(): string {
  const raw = process.env.PASEO_HOME ?? "~/.paseo";
  if (raw === "~") return join(homedir(), "schedules");
  return join(resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw), "schedules");
}

/**
 * This plugin's heartbeats that have not finished, read from the daemon's schedule store:
 * `paseo schedule ls` lists only new-agent schedules, and there is no `heartbeat ls`.
 */
export async function pendingResumeHeartbeats(directory = scheduleDirectory()): Promise<ResumeHeartbeat[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const heartbeats: ResumeHeartbeat[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(join(directory, entry.name), "utf8")) as {
        id?: unknown;
        name?: unknown;
        status?: unknown;
        nextRunAt?: unknown;
        target?: { type?: unknown; agentId?: unknown };
      };
      const agentId = record.target?.type === "agent" ? record.target.agentId : null;
      if (typeof record.id !== "string" || typeof agentId !== "string") continue;
      if (record.name !== `${HEARTBEAT_PREFIX}${agentId}` || record.status === "completed") continue;
      heartbeats.push({
        id: record.id,
        agentId,
        nextRunAt: typeof record.nextRunAt === "string" ? record.nextRunAt : null,
      });
    } catch {
      // A file being rewritten by the daemon; the next read sees it.
    }
  }
  return heartbeats;
}

/** cmd.exe metacharacters. Escaping every one with ^ keeps cmd out of quote mode, so nothing is interpreted. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quotes an argument for the Windows argv parser, then caret-escapes it twice: once for the
 * `cmd /c` line and once for the `.cmd` shim, which re-parses `%*`.
 */
export function quoteCmdShimArg(arg: string): string {
  // Backslashes before a quote, or before the closing quote, are doubled; the quote itself is escaped.
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** How to spawn the CLI without `shell: true`, which joins arguments unquoted on Windows. */
export function cliInvocation(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  // An .exe takes its arguments straight from spawn; `paseo` on Windows is a .cmd shim that needs cmd.
  if (platform !== "win32" || /\.exe$/i.test(executable)) {
    return { command: executable, args: [...args], windowsVerbatimArguments: false };
  }
  const line = [executable.replace(CMD_META, "^$1"), ...args.map(quoteCmdShimArg)].join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

function cronAt(date: Date): string {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
}

function ceilToMinute(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / 60_000) * 60_000);
}

function parseJson<T>(output: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`Paseo CLI returned invalid JSON: ${output.slice(0, 500)}`);
  }
}

function commandError(stderr: string, stdout: string, code: number | null): Error {
  const rendered = stderr.trim() || stdout.trim() || `exit code ${code ?? "unknown"}`;
  try {
    const parsed = JSON.parse(rendered) as { error?: { message?: string }; message?: string };
    return new Error(parsed.error?.message ?? parsed.message ?? rendered);
  } catch {
    return new Error(rendered);
  }
}

function runPaseoJson<T>(args: readonly string[], agentId: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const invocation = cliInvocation(process.env.PASEO_CLI_PATH?.trim() || "paseo", args);
    const child = spawn(invocation.command, invocation.args, {
      env: { ...process.env, PASEO_AGENT_ID: agentId },
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result as T);
    };

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("Paseo CLI output exceeded 64 KiB."));
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) finish(commandError(stderr, stdout, code));
      else {
        try {
          finish(undefined, parseJson<T>(stdout));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`Paseo CLI timed out running ${args.slice(0, 2).join(" ")}.`));
    }, COMMAND_TIMEOUT_MS);
  });
}

async function createSchedule(agentId: string, paseo: PaseoApi): Promise<ScheduleResult> {
  // One resume per agent: a second press, or one after an app reload, gets the pending heartbeat.
  const existing = (await pendingResumeHeartbeats()).find((heartbeat) => heartbeat.agentId === agentId);
  if (existing) {
    return { scheduleId: existing.id, scheduledFor: existing.nextRunAt ?? new Date().toISOString() };
  }
  const refreshed = await paseo.agents.ref(agentId).refresh();
  const agent = refreshed?.agent;
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  const inspection = await inspectAgent(agent, undefined, usageResetReader(paseo));
  if (!inspection.exhausted) {
    throw new Error("The agent's latest failure is no longer a usage-limit failure.");
  }
  if (resumeAction(inspection.resetAt ? new Date(inspection.resetAt) : null) === "continue") {
    throw new Error("The allowance has already renewed; continue the agent instead of scheduling.");
  }
  const resetAt = inspection.resetAt ? new Date(inspection.resetAt) : null;
  if (!resetAt || Number.isNaN(resetAt.getTime())) {
    throw new Error("The latest usage-limit failure does not include a renewal time.");
  }
  const now = Date.now();
  const scheduledAt = ceilToMinute(
    new Date(Math.max(resetAt.getTime() + GRACE_MS, now + MIN_DELAY_MS)),
  );
  const expiresInSeconds = Math.ceil((scheduledAt.getTime() - now) / 1_000) + 86_400;
  const row = await runPaseoJson<ScheduleRow>(
    [
      "heartbeat",
      "create",
      CONTINUE_PROMPT,
      "--cron",
      cronAt(scheduledAt),
      "--timezone",
      "UTC",
      "--name",
      `${HEARTBEAT_PREFIX}${agentId}`,
      "--max-runs",
      "1",
      "--expires-in",
      `${expiresInSeconds}s`,
      "--json",
    ],
    agentId,
  );
  if (!row.id) throw new Error("Paseo CLI did not return a schedule ID.");

  const result = {
    scheduleId: row.id,
    scheduledFor: row.nextRunAt ?? scheduledAt.toISOString(),
  };
  return result;
}

export async function scheduleAgentResume(
  input: { agentId: string },
  context: { paseo: PaseoApi },
): Promise<ScheduleResult> {
  const pending = pendingByAgent.get(input.agentId);
  if (pending) return pending;

  const operation = createSchedule(input.agentId, context.paseo);
  pendingByAgent.set(input.agentId, operation);
  try {
    return await operation;
  } finally {
    pendingByAgent.delete(input.agentId);
  }
}

/** Deletes the agent's pending resume heartbeats, so a manual continue is not followed by a scheduled one. */
export async function cancelAgentResume(input: { agentId: string }): Promise<{ deleted: number }> {
  await pendingByAgent.get(input.agentId)?.catch(() => undefined);
  const heartbeats = (await pendingResumeHeartbeats()).filter((heartbeat) => heartbeat.agentId === input.agentId);
  for (const heartbeat of heartbeats) {
    await runPaseoJson(["heartbeat", "delete", heartbeat.id, "--json"], input.agentId);
  }
  return { deleted: heartbeats.length };
}
