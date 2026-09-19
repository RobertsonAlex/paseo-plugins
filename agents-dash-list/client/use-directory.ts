import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type DirectoryMirror,
  LOADING_STATE,
  createDirectoryMirror,
} from "./directory-mirror";
import type { DashHost } from "./hosts";
import { resolveHostApi } from "./hosts";

/**
 * One live directory mirror per configured host, reconciled as hosts connect, disconnect and are
 * renamed.
 *
 * Mirrors are kept in a ref and reconciled in place rather than rebuilt from an effect's cleanup:
 * a single host going offline must not re-seed every other host's directory. Renders are driven
 * by `version`, bumped at most once per event-loop tick, so a burst of streamed updates across
 * several hosts costs one render instead of one per event.
 */

export type DashDirectoryStatus = "loading" | "ready" | "error" | "offline";

export interface HostDirectory {
  serverId: string;
  label: string;
  status: DashDirectoryStatus;
  error: string | null;
  /**
   * True once this host's workspace seed enumerated its whole directory. Callers that treat the
   * workspace map as a census — the server prunes unread marks against it — must not do so before
   * every host says so.
   */
  complete: boolean;
  workspaces: ReadonlyMap<string, PaseoWorkspace>;
  agents: ReadonlyMap<string, PaseoAgent>;
}

export interface DashDirectories {
  /** In the order `useDashHosts` gave them: the surface's own host first. */
  hosts: readonly HostDirectory[];
  /** Changes whenever any mirror changed; the map identities stay stable. */
  version: number;
  refresh(): void;
}

const EMPTY_WORKSPACES: ReadonlyMap<string, PaseoWorkspace> = new Map();
const EMPTY_AGENTS: ReadonlyMap<string, PaseoAgent> = new Map();

interface MirrorEntry {
  api: PaseoApi;
  mirror: DirectoryMirror;
}

export function useDashDirectories(
  hosts: readonly DashHost[],
  own: { id: string; api: PaseoApi },
): DashDirectories {
  const mirrorsRef = useRef<Map<string, MirrorEntry>>(new Map());
  const bumpScheduledRef = useRef(false);
  const mountedRef = useRef(true);

  const [version, setVersion] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const scheduleBump = useCallback(() => {
    if (bumpScheduledRef.current) return;
    bumpScheduledRef.current = true;
    void Promise.resolve().then(() => {
      bumpScheduledRef.current = false;
      if (!mountedRef.current) return;
      setVersion((current) => current + 1);
    });
  }, []);

  const refresh = useCallback(() => {
    for (const entry of mirrorsRef.current.values()) entry.mirror.stop();
    mirrorsRef.current.clear();
    setReloadToken((current) => current + 1);
  }, []);

  // Reconnects hand out a fresh API object, so the signature has to carry the status as well as
  // the identity: a host that dropped and came back needs its mirror rebuilt on the new handle.
  const signature = hosts.map((host) => `${host.serverId}:${host.status}`).join("\n");

  useEffect(() => {
    const mirrors = mirrorsRef.current;
    const wanted = new Set<string>();
    for (const host of hosts) {
      if (!host.online) continue;
      const api = resolveHostApi(host.serverId, own);
      if (!api) continue;
      wanted.add(host.serverId);
      const existing = mirrors.get(host.serverId);
      if (existing?.api === api) continue;
      existing?.mirror.stop();
      mirrors.set(host.serverId, { api, mirror: createDirectoryMirror(api, scheduleBump) });
    }
    for (const [serverId, entry] of mirrors) {
      if (wanted.has(serverId)) continue;
      entry.mirror.stop();
      mirrors.delete(serverId);
    }
    scheduleBump();
    // `hosts` and `own` are read through `signature`; their identities change on every render.
  }, [signature, reloadToken, scheduleBump]);

  // Teardown belongs to the unmount, not to every reconcile.
  useEffect(
    () => () => {
      for (const entry of mirrorsRef.current.values()) entry.mirror.stop();
      mirrorsRef.current.clear();
    },
    [],
  );

  return useMemo(
    () => ({
      hosts: hosts.map((host) => {
        const entry = mirrorsRef.current.get(host.serverId);
        if (!entry) {
          // Either the host is disconnected, or the reconcile effect has not run yet; both are
          // states the surface can draw, and "loading" is the honest one for a live host.
          return {
            serverId: host.serverId,
            label: host.label,
            status: host.online ? ("loading" as const) : ("offline" as const),
            error: null,
            complete: false,
            workspaces: EMPTY_WORKSPACES,
            agents: EMPTY_AGENTS,
          };
        }
        const state = entry.mirror.state ?? LOADING_STATE;
        return {
          serverId: host.serverId,
          label: host.label,
          status: state.status,
          error: state.error,
          complete: state.complete,
          workspaces: entry.mirror.workspaces,
          agents: entry.mirror.agents,
        };
      }),
      version,
      refresh,
    }),
    // The mirrors are mutated in place; `version` is what says they changed.
    [hosts, version, refresh],
  );
}
