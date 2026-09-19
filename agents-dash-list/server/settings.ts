import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import {
  DEFAULT_DASH_SETTINGS,
  DashSettingsSchema,
  type DashSettings,
  type setDashSettings,
} from "../shared/contracts";
import { paseoHome } from "./paseo-home";

/**
 * The dash's viewing preferences (host filter, project filter, folded groups). Plugins have no
 * client-side storage, so they live next to the unread marks under `$PASEO_HOME` and survive app
 * restarts.
 */

/** Reads and writes run in turn, so two quick changes cannot interleave their file writes. */
let operations: Promise<unknown> = Promise.resolve();

function enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
  const next = operations.then(operation, operation);
  operations = next.catch(() => undefined);
  return next;
}

/** Resolves once no write is in flight; the plugin entry awaits it while unloading. */
export function flushSettingsWrites(): Promise<void> {
  return operations.then(
    () => undefined,
    () => undefined,
  );
}

export function readDashSettings(): Promise<DashSettings> {
  return enqueue(loadSettings);
}

export function writeDashSettings(input: RpcInput<typeof setDashSettings>): Promise<DashSettings> {
  return enqueue(async () => {
    const settings: DashSettings = {
      projectIds: [...new Set(input.projectIds)],
      hostIds: [...new Set(input.hostIds)],
      collapsedGroups: [...new Set(input.collapsedGroups)],
    };
    await persistSettings(settings);
    return settings;
  });
}

function stateDirectory(): string {
  return join(paseoHome(), "plugin-data", "agents-dash-list");
}

function settingsPath(): string {
  return join(stateDirectory(), "settings.json");
}

/** A missing or unusable file means the defaults; it is rewritten on the next change. */
async function loadSettings(): Promise<DashSettings> {
  const path = settingsPath();
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[agents-dash-list] could not read settings at ${path}`);
    }
    return DEFAULT_DASH_SETTINGS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    console.warn(`[agents-dash-list] ignoring unparsable settings at ${path}`);
    return DEFAULT_DASH_SETTINGS;
  }
  const settings = DashSettingsSchema.safeParse(parsed);
  if (!settings.success) {
    console.warn(`[agents-dash-list] ignoring invalid settings at ${path}`);
    return DEFAULT_DASH_SETTINGS;
  }
  return settings.data;
}

/** Writes through a temporary file so an interrupted write cannot truncate the settings. */
async function persistSettings(settings: DashSettings): Promise<void> {
  const target = settingsPath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
