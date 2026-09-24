import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProfileRoutingProvider } from "./server/provider";
import { archiveRouterWhenDelegatesGone } from "./server/archive";
import { readProfileRoutingSettings, writeProfileRoutingSettings } from "./server/settings";
import type { RoutingPaseo } from "./server/route";
import { getProfileRoutingSettings, setProfileRoutingSettings, testProfileRoutingScript } from "./shared/settings";
import { testModelScript } from "./server/pick";

export default function contribute(server: PluginServerContext) {
  let paseo: RoutingPaseo | undefined;
  // Provider code has no paseo handle; the subprocess passes the same SDK to every hook.
  const stopBefore = server.before("agent.session_open", (_input, context) => {
    paseo = context.paseo as unknown as RoutingPaseo;
  });
  const stopArchived = server.on("agent.archived", async (event, context) => {
    try {
      const settings = await readProfileRoutingSettings();
      await archiveRouterWhenDelegatesGone({
        paseo: context.paseo,
        archivedAgentId: event.agent.id,
        archiveRouter: settings.archiveWhenDelegatesArchived,
        archiveWorkspace: settings.archiveWorkspaceWhenEmpty,
      });
    } catch (error) {
      console.error("profile-routing: auto-archive failed", error);
    }
  });
  server.handle(getProfileRoutingSettings, readProfileRoutingSettings);
  server.handle(setProfileRoutingSettings, writeProfileRoutingSettings);
  server.handle(testProfileRoutingScript, ({ script }) => testModelScript(script));
  server.registerProvider(
    createProfileRoutingProvider({
      getPaseo: () => paseo,
      readSettings: readProfileRoutingSettings,
    }),
  );
  return () => {
    stopArchived();
    stopBefore();
  };
}
