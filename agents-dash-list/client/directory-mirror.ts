import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "@getpaseo/client";

import { createSubscriptionKeeper } from "./directory-subscription";

/**
 * Live mirror of one host's workspace and agent directories.
 *
 * The daemon only streams directory updates to a connection that already asked for them, and the
 * SDK's `subscribe` handlers only relay updates from an open `list({ subscribe })` stream, so the
 * mirror registers both handlers before seeding and passes an empty `subscribe` on the first page
 * of each paginated `list`. The stream handles are released by `stop` so a refresh or a host
 * going away does not leave the daemon streaming into nothing. The maps are mutated in place and
 * `onChange` is what says they moved; the caller decides how often that becomes a render.
 *
 * This is deliberately not a hook: the dash mirrors every configured host at once, and the number
 * of hosts changes while the surface is mounted.
 */

const PAGE_LIMIT = 200;
/** Ceiling on seed pages so a huge directory cannot spin forever. */
const MAX_PAGES = 10;

export type DirectoryStatus = "loading" | "ready" | "error";

export interface DirectoryState {
  status: DirectoryStatus;
  error: string | null;
  /** False when the seed hit `MAX_PAGES` while the daemon still had more workspaces. */
  complete: boolean;
}

export const LOADING_STATE: DirectoryState = { status: "loading", error: null, complete: false };

export interface DirectoryMirror {
  readonly workspaces: ReadonlyMap<string, PaseoWorkspace>;
  readonly agents: ReadonlyMap<string, PaseoAgent>;
  readonly state: DirectoryState;
  stop(): void;
}

/** Local copy of the model's timestamp parser: client-only code should not widen shared/. */
function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function directoryErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text && text !== "undefined" ? text : "Could not load the workspace directory.";
}

/**
 * Agents without a workspace (or already archived) never render, so they are dropped instead of
 * stored. An upsert older than the snapshot already held is ignored: `list` pages and streamed
 * updates race, and the newest `updatedAt` is the one that should win.
 */
function applyAgent(agents: Map<string, PaseoAgent>, agent: PaseoAgent): void {
  if (agent.archivedAt || !agent.workspaceId) {
    agents.delete(agent.id);
    return;
  }
  const existing = agents.get(agent.id);
  if (existing && parseTime(agent.updatedAt) < parseTime(existing.updatedAt)) return;
  agents.set(agent.id, agent);
}

export function createDirectoryMirror(paseo: PaseoApi, onChange: () => void): DirectoryMirror {
  const streams = createSubscriptionKeeper();
  const workspaces = new Map<string, PaseoWorkspace>();
  const agents = new Map<string, PaseoAgent>();
  let stopped = false;

  const mirror = {
    workspaces,
    agents,
    state: LOADING_STATE,
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribeWorkspaces();
      unsubscribeAgents();
      streams.release();
    },
  };

  function settle(state: DirectoryState): void {
    mirror.state = state;
    onChange();
  }

  const unsubscribeWorkspaces = paseo.workspaces.subscribe((update) => {
    if (stopped) return;
    if (update.kind === "upsert") workspaces.set(update.workspace.id, update.workspace);
    else workspaces.delete(update.id);
    onChange();
  });

  const unsubscribeAgents = paseo.agents.subscribe((update) => {
    if (stopped) return;
    if (update.kind === "upsert") applyAgent(agents, update.agent);
    else agents.delete(update.agentId);
    onChange();
  });

  /** Resolves to whether every page landed; a truncated seed is not a census. */
  const seedWorkspaces = async (): Promise<boolean> => {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await paseo.workspaces.list({
        sort: [{ key: "activity_at", direction: "desc" }],
        page: { limit: PAGE_LIMIT, cursor },
        ...(page === 0 ? { subscribe: {} } : {}),
      });
      streams.keep(result);
      if (stopped) return false;
      for (const workspace of result.entries) {
        // A streamed update that landed mid-seed is newer than this snapshot page.
        if (!workspaces.has(workspace.id)) workspaces.set(workspace.id, workspace);
      }
      onChange();
      const nextCursor = result.pageInfo.nextCursor;
      if (!result.pageInfo.hasMore || !nextCursor) return true;
      cursor = nextCursor;
    }
    return false;
  };

  const seedAgents = async () => {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await paseo.agents.list({
        filter: { includeArchived: false },
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: PAGE_LIMIT, cursor },
        ...(page === 0 ? { subscribe: {} } : {}),
      });
      streams.keep(result);
      if (stopped) return;
      for (const entry of result.entries) applyAgent(agents, entry.agent);
      onChange();
      const nextCursor = result.pageInfo.nextCursor;
      if (!result.pageInfo.hasMore || !nextCursor) return;
      cursor = nextCursor;
    }
  };

  void (async () => {
    try {
      const complete = await seedWorkspaces();
      await seedAgents();
      if (stopped) return;
      settle({ status: "ready", error: null, complete });
    } catch (cause) {
      if (stopped) return;
      settle({ status: "error", error: directoryErrorMessage(cause), complete: false });
    }
  })();

  return mirror;
}
