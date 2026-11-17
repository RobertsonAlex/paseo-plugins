import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributePills } from "./client/pills";
import { addWorkspaceBadge } from "./client/workspace-badge";

export default function contribute(client: PluginClientContext) {
  const stopPills = contributePills(client);
  const stopBadge = addWorkspaceBadge(client);
  return () => {
    stopBadge();
    stopPills();
  };
}
