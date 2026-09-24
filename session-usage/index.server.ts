import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readAllowances } from "./server/allowances";
import { defaultIndexPath } from "./server/index-store";
import { defaultRoots, UsageIndex } from "./server/indexer";
import { listAllowances, listUsage } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const index = new UsageIndex(defaultRoots(), defaultIndexPath());
  // Start from the persistent index right away, so the first visit finds a fresh snapshot.
  index.snapshot();
  server.handle(listUsage, async ({ refresh, revision }) => {
    index.snapshot(refresh);
    await index.firstScan(1_500);
    return index.view(revision);
  });
  server.handle(listAllowances, ({ refresh }, { paseo }) => readAllowances(paseo, refresh));
  return () => index.dispose();
}
