import { useSyncExternalStore } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import type { WorkspaceBadgeState } from "../shared/workspace-badge";

// One store fed by the pills' agent subscription: every row reads it, none fetches.
let states = new Map<string, WorkspaceBadgeState>();
const listeners = new Set<() => void>();

export function setWorkspaceBadgeStates(next: Map<string, WorkspaceBadgeState>): void {
  if (next.size === states.size && [...next].every(([id, state]) => states.get(id) === state)) return;
  states = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function WorkspaceResumeBadge({ workspaceId }: { workspaceId: string }) {
  const state = useSyncExternalStore(subscribe, () => states.get(workspaceId) ?? null);
  if (state === "scheduled") {
    return <WorkspaceRowBadge icon="Clock" label="Resume queued" tone="warning" />;
  }
  if (state === "exhausted") {
    return <WorkspaceRowBadge icon="TriangleAlert" label="Quota hit" tone="warning" />;
  }
  return null;
}

/** Apps older than Paseo 0.16 have no `addWorkspaceRowBadgeItem`; the badge is skipped there. */
export function addWorkspaceBadge(client: PluginClientContext): () => void {
  if (typeof client.addWorkspaceRowBadgeItem !== "function") return () => undefined;
  const remove = client.addWorkspaceRowBadgeItem({
    id: "chat-resume",
    title: "Chat resume",
    icon: "Clock",
    Component: WorkspaceResumeBadge,
  });
  return () => {
    remove();
    setWorkspaceBadgeStates(new Map());
  };
}
