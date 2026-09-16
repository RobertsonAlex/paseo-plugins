import { ROUTER_LABEL } from "./route";

export type ArchiveOutcome = "archived" | "skipped";

export interface ArchiveRouterPaseo {
  agents: {
    list(options: {
      filter?: { labels?: Record<string, string>; includeArchived?: boolean };
      page?: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{
        agent: { id: string; archivedAt?: string | null; workspaceId?: string | null };
      }>;
      pageInfo?: { hasMore?: boolean; nextCursor?: string | null };
    }>;
    ref(id: string): {
      refresh(): Promise<{
        agent: {
          archivedAt?: string | null;
          labels?: Record<string, string>;
          workspaceId?: string | null;
        };
      } | null>;
      archive(): Promise<{ archivedAt: string }>;
    };
  };
  workspaces: {
    ref(id: string): {
      archive(): Promise<{ archivedAt: string | null; error?: string | null }>;
      terminals?: {
        list(): Promise<{ entries: Array<{ id: string }> }>;
      };
    };
  };
}

const inflight = new Map<string, Promise<void>>();

function routerIdOf(labels: Record<string, string> | undefined): string | null {
  const value = labels?.[ROUTER_LABEL];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function archiveRouterWhenDelegatesGone(options: {
  paseo: ArchiveRouterPaseo;
  archivedAgentId: string;
  archiveRouter: boolean;
  archiveWorkspace: boolean;
}): Promise<{ router: ArchiveOutcome; workspace: ArchiveOutcome }> {
  if (!options.archiveRouter) return { router: "skipped", workspace: "skipped" };
  const refreshed = await options.paseo.agents.ref(options.archivedAgentId).refresh();
  const routerId = routerIdOf(refreshed?.agent.labels);
  if (!routerId || routerId === options.archivedAgentId) {
    return { router: "skipped", workspace: "skipped" };
  }

  const previous = inflight.get(routerId);
  if (previous) await previous.catch(() => undefined);

  let outcome: { router: ArchiveOutcome; workspace: ArchiveOutcome } = {
    router: "skipped",
    workspace: "skipped",
  };
  const operation = (async () => {
    outcome = await archiveIfIdle(
      options.paseo,
      routerId,
      options.archivedAgentId,
      options.archiveWorkspace,
    );
  })();
  inflight.set(routerId, operation);
  try {
    await operation;
    return outcome;
  } finally {
    if (inflight.get(routerId) === operation) inflight.delete(routerId);
  }
}

async function archiveIfIdle(
  paseo: ArchiveRouterPaseo,
  routerId: string,
  archivedAgentId: string,
  archiveWorkspace: boolean,
): Promise<{ router: ArchiveOutcome; workspace: ArchiveOutcome }> {
  const listed = await paseo.agents.list({
    filter: { labels: { [ROUTER_LABEL]: routerId }, includeArchived: false },
    page: { limit: 20 },
  });
  const remaining = listed.entries.some(
    (entry) => entry.agent.id !== archivedAgentId && !entry.agent.archivedAt,
  );
  if (remaining) return { router: "skipped", workspace: "skipped" };

  const router = await paseo.agents.ref(routerId).refresh();
  if (!router?.agent || router.agent.archivedAt) return { router: "skipped", workspace: "skipped" };
  await paseo.agents.ref(routerId).archive();
  if (!archiveWorkspace) return { router: "archived", workspace: "skipped" };
  return {
    router: "archived",
    workspace: await archiveWorkspaceIfEmpty(
      paseo,
      router.agent.workspaceId ?? null,
      new Set([routerId, archivedAgentId]),
    ),
  };
}

async function archiveWorkspaceIfEmpty(
  paseo: ArchiveRouterPaseo,
  workspaceId: string | null,
  ignoreIds: Set<string>,
): Promise<ArchiveOutcome> {
  if (!workspaceId) return "skipped";
  if (await workspaceHasOtherOccupants(paseo, workspaceId, ignoreIds)) return "skipped";
  const result = await paseo.workspaces.ref(workspaceId).archive();
  if (result.error || !result.archivedAt) return "skipped";
  return "archived";
}

async function workspaceHasOtherOccupants(
  paseo: ArchiveRouterPaseo,
  workspaceId: string,
  ignoreIds: Set<string>,
): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await paseo.agents.list({
      filter: { includeArchived: false },
      page: { limit: 200, cursor },
    });
    if (
      listed.entries.some(
        (entry) =>
          entry.agent.workspaceId === workspaceId &&
          !ignoreIds.has(entry.agent.id) &&
          !entry.agent.archivedAt,
      )
    ) {
      return true;
    }
    const next = listed.pageInfo?.nextCursor;
    if (!listed.pageInfo?.hasMore || !next) break;
    cursor = next;
  }
  try {
    const listed = await paseo.workspaces.ref(workspaceId).terminals?.list();
    if (!listed) return true;
    return listed.entries.length > 0;
  } catch {
    return true;
  }
}
