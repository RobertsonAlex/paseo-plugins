import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsSurface } from "./client/settings";

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
  return () => {
    removeCommand();
    removeSettings();
  };
}
