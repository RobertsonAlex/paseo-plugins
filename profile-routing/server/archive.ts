import { ROUTER_LABEL } from "./route";

export interface ArchiveRouterPaseo {
  agents: {
    list(options: {
      filter?: { labels?: Record<string, string>; includeArchived?: boolean };
      page?: { limit: number };
    }): Promise<{ entries: Array<{ agent: { id: string; archivedAt?: string | null } }> }>;
    ref(id: string): {
      refresh(): Promise<{
        agent: {
          archivedAt?: string | null;
          labels?: Record<string, string>;
        };
      } | null>;
      archive(): Promise<{ archivedAt: string }>;
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
  enabled: boolean;
}): Promise<"archived" | "skipped"> {
  if (!options.enabled) return "skipped";
  const refreshed = await options.paseo.agents.ref(options.archivedAgentId).refresh();
  const routerId = routerIdOf(refreshed?.agent.labels);
  if (!routerId || routerId === options.archivedAgentId) return "skipped";

  const previous = inflight.get(routerId);
  if (previous) await previous.catch(() => undefined);

  let outcome: "archived" | "skipped" = "skipped";
  const operation = (async () => {
    outcome = await archiveIfIdle(options.paseo, routerId, options.archivedAgentId);
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
): Promise<"archived" | "skipped"> {
  const listed = await paseo.agents.list({
    filter: { labels: { [ROUTER_LABEL]: routerId }, includeArchived: false },
    page: { limit: 20 },
  });
  const remaining = listed.entries.some(
    (entry) => entry.agent.id !== archivedAgentId && !entry.agent.archivedAt,
  );
  if (remaining) return "skipped";

  const router = await paseo.agents.ref(routerId).refresh();
  if (!router?.agent || router.agent.archivedAt) return "skipped";
  await paseo.agents.ref(routerId).archive();
  return "archived";
}
