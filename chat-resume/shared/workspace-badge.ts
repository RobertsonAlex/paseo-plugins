export type WorkspaceBadgeState = "scheduled" | "exhausted";

/** Per workspace: a scheduled resume outranks a quota stop. Workspaces with neither are absent. */
export function workspaceBadgeStates(
  agents: Iterable<{ id: string; workspaceId?: string | null }>,
  scheduled: ReadonlySet<string>,
  exhausted: ReadonlySet<string>,
): Map<string, WorkspaceBadgeState> {
  const states = new Map<string, WorkspaceBadgeState>();
  for (const agent of agents) {
    if (!agent.workspaceId) continue;
    if (scheduled.has(agent.id)) states.set(agent.workspaceId, "scheduled");
    else if (exhausted.has(agent.id) && !states.has(agent.workspaceId)) states.set(agent.workspaceId, "exhausted");
  }
  return states;
}
