import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROFILE_ROUTING_SETTINGS,
  ProfileRoutingSettingsSchema,
  type ProfileRoutingSettings,
} from "../shared/settings";

function settingsDirectory(): string {
  return join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "profile-routing");
}

export async function readProfileRoutingSettings(): Promise<ProfileRoutingSettings> {
  try {
    const parsed = ProfileRoutingSettingsSchema.safeParse(
      JSON.parse(await readFile(join(settingsDirectory(), "settings.json"), "utf8")),
    );
    if (parsed.success) return parsed.data;
    console.warn("[profile-routing] ignoring invalid settings", parsed.error.message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[profile-routing] could not read settings", error);
    }
  }
  return DEFAULT_PROFILE_ROUTING_SETTINGS;
}

export async function writeProfileRoutingSettings(
  settings: ProfileRoutingSettings,
): Promise<ProfileRoutingSettings> {
  const normalized = ProfileRoutingSettingsSchema.parse(settings);
  const directory = settingsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `settings.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, join(directory, "settings.json"));
  } finally {
    await rm(temporary, { force: true });
  }
  return normalized;
}
