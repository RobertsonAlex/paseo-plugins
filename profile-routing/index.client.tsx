import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RoutingNote } from "./client/routing-note";
import { SettingsSurface } from "./client/settings";
import {
  ROUTING_NOTE_KIND,
  ROUTING_NOTE_VERSION,
  RoutingNoteDataSchema,
} from "./shared/routing-note";

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "settings",
    title: "Profile routing",
    icon: "GitFork",
    Component: SettingsSurface,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "configure-profile-routing",
    title: "Configure profile routing",
    icon: "GitFork",
    keywords: ["profile", "routing", "model-pick", "timeout"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("settings");
    },
  });
  const removeRenderer = client.addTimelineRenderer({
    kind: ROUTING_NOTE_KIND,
    version: ROUTING_NOTE_VERSION,
    schema: RoutingNoteDataSchema,
    Component: RoutingNote,
  });
  return () => {
    removeRenderer();
    removeCommand();
    removeSettings();
  };
}
