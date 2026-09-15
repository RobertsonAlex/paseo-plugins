import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProfileRoutingProvider } from "./server/provider";
import { readProfileRoutingSettings, writeProfileRoutingSettings } from "./server/settings";
import type { RoutingPaseo } from "./server/route";
import { getProfileRoutingSettings, setProfileRoutingSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  let paseo: RoutingPaseo | undefined;
  // Provider code has no paseo handle; the subprocess passes the same SDK to every hook.
  const stopBefore = server.before("agent.session_open", (_input, context) => {
    paseo = context.paseo as unknown as RoutingPaseo;
  });
  server.handle(getProfileRoutingSettings, readProfileRoutingSettings);
  server.handle(setProfileRoutingSettings, writeProfileRoutingSettings);
  server.registerProvider(
    createProfileRoutingProvider({
      getPaseo: () => paseo,
      readSettings: readProfileRoutingSettings,
    }),
  );
  return () => {
    stopBefore();
  };
}
