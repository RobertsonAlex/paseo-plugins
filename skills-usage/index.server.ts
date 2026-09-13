import type { PluginServerContext } from "@getpaseo/plugin/server";
import { locateAgentSkills } from "./server/locate-agent-skills";
import { locateSkillsRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(locateSkillsRpc, locateAgentSkills);
  return () => {};
}
