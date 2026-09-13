import { useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { locateSkillsRpc } from "../shared/contracts";
import { listSkills, scanTimelineEntries, type AvailableSkill, type SkillUse } from "../shared/skills";

const AVAILABLE_STALE_MS = 5 * 60_000;
const SCOPES_STALE_MS = 60_000;
const USED_STALE_MS = 10_000;
const RUNNING_REFRESH_MS = 15_000;

export interface AvailableSkillsResult {
  skills: AvailableSkill[];
  error: string | null;
}

export function availableSkillsKey(hostId: string, agentId: string) {
  return ["skills-usage", "available", hostId, agentId] as const;
}

export function usedSkillsKey(hostId: string, agentId: string) {
  return ["skills-usage", "used", hostId, agentId] as const;
}

export function skillScopesKey(hostId: string, agentId: string) {
  return ["skills-usage", "scopes", hostId, agentId] as const;
}

/** Where each skill lives on the daemon machine, keyed by skill name. */
export function useSkillScopes(hostId: string, agentId: string) {
  const locate = useRpc(locateSkillsRpc);
  return useQuery({
    queryKey: skillScopesKey(hostId, agentId),
    queryFn: () => locate({ agentId }),
    staleTime: SCOPES_STALE_MS,
  });
}

/** Skills the running session reports, from the provider's own command list. */
export function useAvailableSkills(hostId: string, agentId: string) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: availableSkillsKey(hostId, agentId),
    queryFn: async (): Promise<AvailableSkillsResult> => {
      const result = await paseo.agents.ref(agentId).commands();
      const commands = result.commands as readonly {
        name: string;
        description: string;
        argumentHint: string;
        kind?: string;
      }[];
      return { skills: listSkills(commands), error: result.error ?? null };
    },
    staleTime: AVAILABLE_STALE_MS,
  });
}

/** Every skill use visible in the agent's timeline, refreshed when a turn starts or ends. */
export function useSkillUses(hostId: string, agentId: string) {
  const paseo = usePaseo();
  const status = useAgent(agentId, (agent) => agent.status);
  const query = useQuery({
    queryKey: usedSkillsKey(hostId, agentId),
    queryFn: async (): Promise<SkillUse[]> => {
      const page = await paseo.agents.ref(agentId).timeline.refetch({
        direction: "tail",
        limit: 0,
        projection: "projected",
      });
      return scanTimelineEntries(page.entries);
    },
    staleTime: USED_STALE_MS,
    refetchInterval: status === "running" ? RUNNING_REFRESH_MS : false,
  });
  const previousStatus = useRef(status);
  const refetch = query.refetch;
  useEffect(() => {
    if (previousStatus.current === status) return;
    previousStatus.current = status;
    void refetch();
  }, [refetch, status]);
  return query;
}
