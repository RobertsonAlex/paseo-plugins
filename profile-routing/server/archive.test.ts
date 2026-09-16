import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTER_LABEL } from "./route";
import { archiveRouterWhenDelegatesGone, type ArchiveRouterPaseo } from "./archive";

interface FakeAgent {
  id: string;
  archivedAt?: string | null;
  labels?: Record<string, string>;
}

function fakePaseo(agents: FakeAgent[], archives: string[] = []): ArchiveRouterPaseo {
  return {
    agents: {
      async list(options) {
        const wanted = options.filter?.labels?.[ROUTER_LABEL];
        const includeArchived = options.filter?.includeArchived === true;
        return {
          entries: agents
            .filter((agent) => {
              if (wanted && agent.labels?.[ROUTER_LABEL] !== wanted) return false;
              if (!includeArchived && agent.archivedAt) return false;
              return true;
            })
            .map((agent) => ({ agent })),
        };
      },
      ref(id) {
        return {
          async refresh() {
            const agent = agents.find((entry) => entry.id === id);
            return agent ? { agent } : null;
          },
          async archive() {
            archives.push(id);
            const agent = agents.find((entry) => entry.id === id);
            if (agent) agent.archivedAt = "2026-09-16T08:00:00.000Z";
            return { archivedAt: "2026-09-16T08:00:00.000Z" };
          },
        };
      },
    },
  };
}

test("archiveRouterWhenDelegatesGone archives the router once its last delegate is gone", async () => {
  const archives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1" },
      {
        id: "delegate-1",
        archivedAt: "2026-09-16T08:00:00.000Z",
        labels: { [ROUTER_LABEL]: "router-1" },
      },
    ],
    archives,
  );
  assert.equal(
    await archiveRouterWhenDelegatesGone({ paseo, archivedAgentId: "delegate-1", enabled: true }),
    "archived",
  );
  assert.deepEqual(archives, ["router-1"]);
});

test("archiveRouterWhenDelegatesGone waits while another delegate is still live", async () => {
  const archives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1" },
      {
        id: "delegate-1",
        archivedAt: "2026-09-16T08:00:00.000Z",
        labels: { [ROUTER_LABEL]: "router-1" },
      },
      { id: "delegate-2", labels: { [ROUTER_LABEL]: "router-1" } },
    ],
    archives,
  );
  assert.equal(
    await archiveRouterWhenDelegatesGone({ paseo, archivedAgentId: "delegate-1", enabled: true }),
    "skipped",
  );
  assert.deepEqual(archives, []);
});

test("archiveRouterWhenDelegatesGone skips when the setting is off", async () => {
  const archives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1" },
      { id: "delegate-1", labels: { [ROUTER_LABEL]: "router-1" } },
    ],
    archives,
  );
  assert.equal(
    await archiveRouterWhenDelegatesGone({ paseo, archivedAgentId: "delegate-1", enabled: false }),
    "skipped",
  );
  assert.deepEqual(archives, []);
});

test("archiveRouterWhenDelegatesGone skips agents that were not started by a router", async () => {
  const archives: string[] = [];
  const paseo = fakePaseo([{ id: "other-1" }], archives);
  assert.equal(
    await archiveRouterWhenDelegatesGone({ paseo, archivedAgentId: "other-1", enabled: true }),
    "skipped",
  );
  assert.deepEqual(archives, []);
});

test("archiveRouterWhenDelegatesGone skips an already archived router", async () => {
  const archives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1", archivedAt: "2026-09-16T07:00:00.000Z" },
      {
        id: "delegate-1",
        archivedAt: "2026-09-16T08:00:00.000Z",
        labels: { [ROUTER_LABEL]: "router-1" },
      },
    ],
    archives,
  );
  assert.equal(
    await archiveRouterWhenDelegatesGone({ paseo, archivedAgentId: "delegate-1", enabled: true }),
    "skipped",
  );
  assert.deepEqual(archives, []);
});
