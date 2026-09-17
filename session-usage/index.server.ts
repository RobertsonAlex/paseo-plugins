import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defaultIndexPath } from "./server/index-store";
import { defaultRoots, UsageIndex } from "./server/indexer";
import { listUsage } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const index = new UsageIndex(defaultRoots(), defaultIndexPath());
  server.handle(listUsage, ({ refresh }) => index.snapshot(refresh));
  return () => index.dispose();
}
