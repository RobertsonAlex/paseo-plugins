import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributePills } from "./client/pill";

export default function contribute(client: PluginClientContext) {
  const removePills = contributePills(client);
  return () => {
    removePills();
  };
}
