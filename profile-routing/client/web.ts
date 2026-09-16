import { Platform } from "react-native";

interface WebLocation {
  assign(url: string): void;
}

declare const window: { location: WebLocation } | undefined;

/** In-app path for the agent detail route (`/h/<host>/agent/<id>`). */
export function agentDetailPath(hostId: string, agentId: string): string {
  return `/h/${encodeURIComponent(hostId)}/agent/${encodeURIComponent(agentId)}`;
}

/**
 * Navigate inside the web/desktop renderer. Returns false on native, where the
 * caller should fall back to a `paseo:` deep link.
 */
export function openAgentPath(path: string): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  window.location.assign(path);
  return true;
}
