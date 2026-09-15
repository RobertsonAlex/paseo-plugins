import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProfileRoutingProvider } from "./server/provider";
import type { RoutingPaseo } from "./server/route";

export default function contribute(server: PluginServerContext) {
  let paseo: RoutingPaseo | undefined;
  // Provider code has no paseo handle; the subprocess passes the same SDK to every hook.
  const stopBefore = server.before("agent.session_open", (_input, context) => {
    paseo = context.paseo as unknown as RoutingPaseo;
  });
  server.registerProvider(createProfileRoutingProvider(() => paseo));
  return () => {
    stopBefore();
  };
}
