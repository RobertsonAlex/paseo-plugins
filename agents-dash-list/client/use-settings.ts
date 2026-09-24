import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { DEFAULT_DASH_SETTINGS, type DashSettings } from "../shared/contracts";
import { getDashSettings, setDashSettings } from "../shared/contracts";
import type { DashGroup } from "../shared/model";

/**
 * The dash's viewing preferences, stored by the server entry per daemon so they survive app
 * restarts. Changes apply to the cache at once and are written through; a failed write is
 * reported and the previous settings come back.
 */

export interface DashSettingsApi {
  /** Defaults until the first read answers; `ready` says which. */
  settings: DashSettings;
  ready: boolean;
  projectIds: ReadonlySet<string>;
  /** Server IDs the user chose to show; empty means every configured host. */
  hostIds: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<DashGroup>;
  setProjectIds(projectIds: Iterable<string>): void;
  toggleProject(projectId: string): void;
  setHostIds(hostIds: Iterable<string>): void;
  toggleHost(serverId: string): void;
  toggleGroup(group: DashGroup): void;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text && text !== "undefined" ? text : "Could not save the dash settings.";
}

export function useDashSettings(hostId: string): DashSettingsApi {
  const fetchSettings = useRpc(getDashSettings);
  const writeSettings = useRpc(setDashSettings);
  const queryClient = useQueryClient();
  const toast = useToast();

  const queryKey = useMemo(() => ["agents-dash-list", "settings", hostId] as const, [hostId]);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchSettings({}),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const mutation = useMutation({
    mutationFn: (next: DashSettings) => writeSettings(next),
    async onMutate(next: DashSettings) {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<DashSettings>(queryKey);
      queryClient.setQueryData(queryKey, next);
      return { previous };
    },
    onSuccess(saved: DashSettings) {
      queryClient.setQueryData(queryKey, saved);
    },
    onError(cause: unknown, _next, context) {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      toast.error(errorMessage(cause));
    },
  });

  const settings = query.data ?? DEFAULT_DASH_SETTINGS;
  const projectIds = useMemo(() => new Set(settings.projectIds), [settings.projectIds]);
  const hostIds = useMemo(() => new Set(settings.hostIds), [settings.hostIds]);
  const collapsedGroups = useMemo(
    () => new Set(settings.collapsedGroups),
    [settings.collapsedGroups],
  );

  const mutate = mutation.mutate;
  const update = useCallback(
    (change: (current: DashSettings) => DashSettings) => {
      // Read the cache rather than the render's copy: two toggles in one tick must both land.
      const current = queryClient.getQueryData<DashSettings>(queryKey) ?? DEFAULT_DASH_SETTINGS;
      mutate(change(current));
    },
    [mutate, queryClient, queryKey],
  );

  const setProjectIds = useCallback(
    (ids: Iterable<string>) => update((current) => ({ ...current, projectIds: [...new Set(ids)] })),
    [update],
  );
  const toggleProject = useCallback(
    (projectId: string) =>
      update((current) => {
        const next = new Set(current.projectIds);
        if (next.has(projectId)) next.delete(projectId);
        else next.add(projectId);
        return { ...current, projectIds: [...next] };
      }),
    [update],
  );
  const setHostIds = useCallback(
    (ids: Iterable<string>) => update((current) => ({ ...current, hostIds: [...new Set(ids)] })),
    [update],
  );
  const toggleHost = useCallback(
    (serverId: string) =>
      update((current) => {
        const next = new Set(current.hostIds);
        if (next.has(serverId)) next.delete(serverId);
        else next.add(serverId);
        return { ...current, hostIds: [...next] };
      }),
    [update],
  );
  const toggleGroup = useCallback(
    (group: DashGroup) =>
      update((current) => {
        const next = new Set(current.collapsedGroups);
        if (next.has(group)) next.delete(group);
        else next.add(group);
        return { ...current, collapsedGroups: [...next] };
      }),
    [update],
  );

  return {
    settings,
    ready: query.data !== undefined,
    projectIds,
    hostIds,
    collapsedGroups,
    setProjectIds,
    toggleProject,
    setHostIds,
    toggleHost,
    toggleGroup,
  };
}
