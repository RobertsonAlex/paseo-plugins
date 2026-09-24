import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { locateSkillsRpc } from "../shared/contracts";
import { locateSkills } from "./locate-skills";

const CACHE_TTL_MS = 15_000;

const cache = new Map<string, { at: number; result: Promise<RpcOutput<typeof locateSkillsRpc>["found"]> }>();

/** Resolves the agent's working directory, then scans its skill directories (cached per cwd). */
export async function locateAgentSkills(
  { agentId }: RpcInput<typeof locateSkillsRpc>,
  { paseo }: PluginHandlerContext,
): Promise<RpcOutput<typeof locateSkillsRpc>> {
  const refreshed = await paseo.agents.ref(agentId).refresh();
  const cwd = refreshed?.agent.cwd;
  if (!cwd) return { found: {}, error: `Agent not found: ${agentId}` };

  const now = Date.now();
  let entry = cache.get(cwd);
  if (!entry || now - entry.at > CACHE_TTL_MS) {
    entry = { at: now, result: locateSkills(cwd) };
    cache.set(cwd, entry);
  }
  try {
    return { found: await entry.result, error: null };
  } catch (error) {
    cache.delete(cwd);
    console.error("[skills-usage] could not locate skills", cwd, error);
    return { found: {}, error: error instanceof Error ? error.message : String(error) };
  }
}
