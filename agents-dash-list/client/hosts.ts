import type { PaseoApi } from "@getpaseo/client";
import * as pluginClient from "@getpaseo/plugin/client";
import { useMemo } from "react";

/**
 * The configured hosts, read defensively.
 *
 * `useHosts` and `getPaseoClient` arrived in Paseo 0.8. On an older app the module simply has no
 * such exports, and a plain named import would blow up the whole surface, so both are captured at
 * module scope and replaced with a single-host fallback when they are missing. The capture also
 * keeps the hook call unconditional, which is what the rules of hooks actually ask for: whether
 * the app supports multiple hosts cannot change while the plugin is loaded.
 */

export type HostStatus = "idle" | "connecting" | "online" | "offline" | "error";

export interface DashHost {
  serverId: string;
  label: string;
  status: HostStatus;
  /** False when the host's API cannot be borrowed, so its section stays empty but visible. */
  online: boolean;
}

interface HostSummary {
  readonly serverId: string;
  readonly label: string;
  readonly status: HostStatus;
}

const readHosts: () => readonly HostSummary[] | null =
  typeof (pluginClient as { useHosts?: unknown }).useHosts === "function"
    ? (pluginClient as unknown as { useHosts: () => readonly HostSummary[] }).useHosts
    : () => null;

const borrowClient: ((serverId: string) => PaseoApi) | null =
  typeof (pluginClient as { getPaseoClient?: unknown }).getPaseoClient === "function"
    ? (pluginClient as unknown as { getPaseoClient: (serverId: string) => PaseoApi })
        .getPaseoClient
    : null;

/** True when this app can show more than the host the surface was opened on. */
export const MULTI_HOST_SUPPORTED = borrowClient !== null;

/**
 * Every configured host, with the surface's own host guaranteed to be present and first: the app
 * lists it too, but an older app lists nothing at all, and the dash must still work there.
 */
export function useDashHosts(own: { id: string; label: string }): readonly DashHost[] {
  const summaries = readHosts();
  return useMemo(() => {
    const hosts: DashHost[] = [];
    for (const summary of summaries ?? []) {
      hosts.push({
        serverId: summary.serverId,
        label: summary.label,
        status: summary.status,
        online: summary.status === "online" && borrowClient !== null,
      });
    }
    const ownIndex = hosts.findIndex((host) => host.serverId === own.id);
    if (ownIndex < 0) {
      // No multi-host app, or a host list that has not caught up with this surface yet.
      hosts.unshift({ serverId: own.id, label: own.label, status: "online", online: true });
    } else if (ownIndex > 0) {
      const [host] = hosts.splice(ownIndex, 1);
      if (host) hosts.unshift(host);
    }
    return hosts;
  }, [own.id, own.label, summaries]);
}

/**
 * Borrows a host's API, or answers null when it is offline or the app predates multi-host
 * reading. The surface's own API is passed in because `usePaseo` always has it, even on an app
 * without `getPaseoClient`, and because a borrowed handle is released when its connection is
 * replaced while `usePaseo`'s is not.
 */
export function resolveHostApi(
  serverId: string,
  own: { id: string; api: PaseoApi },
): PaseoApi | null {
  if (serverId === own.id) return own.api;
  if (!borrowClient) return null;
  try {
    return borrowClient(serverId);
  } catch {
    // Unknown or disconnected host: the caller renders it as unavailable instead of failing.
    return null;
  }
}
