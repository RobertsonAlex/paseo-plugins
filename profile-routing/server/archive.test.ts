import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTER_LABEL } from "./route";
import { archiveRouterWhenDelegatesGone, type ArchiveRouterPaseo } from "./archive";

interface FakeAgent {
  id: string;
  archivedAt?: string | null;
  labels?: Record<string, string>;
  workspaceId?: string | null;
}

interface FakeTerminal {
  id: string;
  workspaceId: string;
}

function fakePaseo(
  agents: FakeAgent[],
  archives: string[] = [],
  options: { terminals?: FakeTerminal[]; workspaceArchives?: string[] } = {},
): ArchiveRouterPaseo {
  const terminals = options.terminals ?? [];
  const workspaceArchives = options.workspaceArchives ?? [];
  return {
    agents: {
      async list(listOptions) {
        const wanted = listOptions.filter?.labels?.[ROUTER_LABEL];
        const includeArchived = listOptions.filter?.includeArchived === true;
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
    workspaces: {
      ref(id) {
        return {
          async archive() {
            workspaceArchives.push(id);
            return { archivedAt: "2026-09-16T08:00:00.000Z", error: null };
          },
          terminals: {
            async list() {
              return {
                entries: terminals
                  .filter((terminal) => terminal.workspaceId === id)
                  .map((terminal) => ({ id: terminal.id })),
              };
            },
          },
        };
      },
    },
  };
}

const empty = { router: "skipped", workspace: "skipped" } as const;

test("archiveRouterWhenDelegatesGone archives the router once its last delegate is gone", async () => {
  const archives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1", workspaceId: "ws-1" },
      {
        id: "delegate-1",
        archivedAt: "2026-09-16T08:00:00.000Z",
        labels: { [ROUTER_LABEL]: "router-1" },
        workspaceId: "ws-1",
      },
    ],
    archives,
  );
  assert.deepEqual(
    await archiveRouterWhenDelegatesGone({
      paseo,
      archivedAgentId: "delegate-1",
      archiveRouter: true,
      archiveWorkspace: false,
    }),
    { router: "archived", workspace: "skipped" },
  );
  assert.deepEqual(archives, ["router-1"]);
});

test("archiveRouterWhenDelegatesGone waits while another delegate is still live", async () => {
  const archives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1", workspaceId: "ws-1" },
      {
        id: "delegate-1",
        archivedAt: "2026-09-16T08:00:00.000Z",
        labels: { [ROUTER_LABEL]: "router-1" },
        workspaceId: "ws-1",
      },
      { id: "delegate-2", labels: { [ROUTER_LABEL]: "router-1" }, workspaceId: "ws-1" },
    ],
    archives,
  );
  assert.deepEqual(
    await archiveRouterWhenDelegatesGone({
      paseo,
      archivedAgentId: "delegate-1",
      archiveRouter: true,
      archiveWorkspace: true,
    }),
    empty,
  );
  assert.deepEqual(archives, []);
});

test("archiveRouterWhenDelegatesGone skips when the setting is off", async () => {
  const archives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1", workspaceId: "ws-1" },
      { id: "delegate-1", labels: { [ROUTER_LABEL]: "router-1" }, workspaceId: "ws-1" },
    ],
    archives,
  );
  assert.deepEqual(
    await archiveRouterWhenDelegatesGone({
      paseo,
      archivedAgentId: "delegate-1",
      archiveRouter: false,
      archiveWorkspace: true,
    }),
    empty,
  );
  assert.deepEqual(archives, []);
});

test("archiveRouterWhenDelegatesGone skips agents that were not started by a router", async () => {
  const archives: string[] = [];
  const paseo = fakePaseo([{ id: "other-1", workspaceId: "ws-1" }], archives);
  assert.deepEqual(
    await archiveRouterWhenDelegatesGone({
      paseo,
      archivedAgentId: "other-1",
      archiveRouter: true,
      archiveWorkspace: true,
    }),
    empty,
  );
  assert.deepEqual(archives, []);
});

test("archiveRouterWhenDelegatesGone skips an already archived router", async () => {
  const archives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1", archivedAt: "2026-09-16T07:00:00.000Z", workspaceId: "ws-1" },
      {
        id: "delegate-1",
        archivedAt: "2026-09-16T08:00:00.000Z",
        labels: { [ROUTER_LABEL]: "router-1" },
        workspaceId: "ws-1",
      },
    ],
    archives,
  );
  assert.deepEqual(
    await archiveRouterWhenDelegatesGone({
      paseo,
      archivedAgentId: "delegate-1",
      archiveRouter: true,
      archiveWorkspace: true,
    }),
    empty,
  );
  assert.deepEqual(archives, []);
});

test("archiveRouterWhenDelegatesGone archives the workspace when the router was the last occupant", async () => {
  const archives: string[] = [];
  const workspaceArchives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1", workspaceId: "ws-1" },
      {
        id: "delegate-1",
        archivedAt: "2026-09-16T08:00:00.000Z",
        labels: { [ROUTER_LABEL]: "router-1" },
        workspaceId: "ws-1",
      },
    ],
    archives,
    { workspaceArchives },
  );
  assert.deepEqual(
    await archiveRouterWhenDelegatesGone({
      paseo,
      archivedAgentId: "delegate-1",
      archiveRouter: true,
      archiveWorkspace: true,
    }),
    { router: "archived", workspace: "archived" },
  );
  assert.deepEqual(archives, ["router-1"]);
  assert.deepEqual(workspaceArchives, ["ws-1"]);
});

test("archiveRouterWhenDelegatesGone keeps the workspace when another agent is live", async () => {
  const archives: string[] = [];
  const workspaceArchives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1", workspaceId: "ws-1" },
      {
        id: "delegate-1",
        archivedAt: "2026-09-16T08:00:00.000Z",
        labels: { [ROUTER_LABEL]: "router-1" },
        workspaceId: "ws-1",
      },
      { id: "other-1", workspaceId: "ws-1" },
    ],
    archives,
    { workspaceArchives },
  );
  assert.deepEqual(
    await archiveRouterWhenDelegatesGone({
      paseo,
      archivedAgentId: "delegate-1",
      archiveRouter: true,
      archiveWorkspace: true,
    }),
    { router: "archived", workspace: "skipped" },
  );
  assert.deepEqual(archives, ["router-1"]);
  assert.deepEqual(workspaceArchives, []);
});

test("archiveRouterWhenDelegatesGone keeps the workspace when a terminal is live", async () => {
  const archives: string[] = [];
  const workspaceArchives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1", workspaceId: "ws-1" },
      {
        id: "delegate-1",
        archivedAt: "2026-09-16T08:00:00.000Z",
        labels: { [ROUTER_LABEL]: "router-1" },
        workspaceId: "ws-1",
      },
    ],
    archives,
    { terminals: [{ id: "term-1", workspaceId: "ws-1" }], workspaceArchives },
  );
  assert.deepEqual(
    await archiveRouterWhenDelegatesGone({
      paseo,
      archivedAgentId: "delegate-1",
      archiveRouter: true,
      archiveWorkspace: true,
    }),
    { router: "archived", workspace: "skipped" },
  );
  assert.deepEqual(archives, ["router-1"]);
  assert.deepEqual(workspaceArchives, []);
});

test("archiveRouterWhenDelegatesGone skips the workspace when that setting is off", async () => {
  const archives: string[] = [];
  const workspaceArchives: string[] = [];
  const paseo = fakePaseo(
    [
      { id: "router-1", workspaceId: "ws-1" },
      {
        id: "delegate-1",
        archivedAt: "2026-09-16T08:00:00.000Z",
        labels: { [ROUTER_LABEL]: "router-1" },
        workspaceId: "ws-1",
      },
    ],
    archives,
    { workspaceArchives },
  );
  assert.deepEqual(
    await archiveRouterWhenDelegatesGone({
      paseo,
      archivedAgentId: "delegate-1",
      archiveRouter: true,
      archiveWorkspace: false,
    }),
    { router: "archived", workspace: "skipped" },
  );
  assert.deepEqual(archives, ["router-1"]);
  assert.deepEqual(workspaceArchives, []);
});
