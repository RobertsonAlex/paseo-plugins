import type { PluginServerContext } from "@getpaseo/plugin/server";
import { clearDecorationCache, readDecorations } from "./server/decorations";
import { flushSettingsWrites, readDashSettings, writeDashSettings } from "./server/settings";
import { flushUnreadWrites, readUnreadMarks, writeUnreadMark } from "./server/unread";
import {
  getDashSettings,
  getDecorations,
  listUnreadMarks,
  setDashSettings,
  setUnreadMark,
} from "./shared/contracts";

/**
 * The dashboard reads workspaces and agents through the client SDK; only the things that live on
 * the daemon's disk — project icons, the label catalog, the plugin's own unread marks and its
 * viewing preferences — need a server side.
 */
export default function contribute(server: PluginServerContext) {
  server.handle(getDecorations, readDecorations);
  server.handle(listUnreadMarks, readUnreadMarks);
  server.handle(setUnreadMark, writeUnreadMark);
  server.handle(getDashSettings, readDashSettings);
  server.handle(setDashSettings, writeDashSettings);
  return async () => {
    clearDecorationCache();
    await Promise.all([flushUnreadWrites(), flushSettingsWrites()]);
  };
}
