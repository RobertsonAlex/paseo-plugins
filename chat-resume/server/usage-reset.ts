import type { PaseoApi } from "@getpaseo/client";

interface UsageWindow {
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
}

interface ProviderUsage {
  providerId?: unknown;
  windows?: unknown;
}

/** Reads the renewal time for a provider's exhausted allowance; null when unknown. */
export type UsageResetReader = (provider: string) => Promise<string | null>;

function exhausted(window: UsageWindow): boolean {
  return (typeof window.usedPct === "number" && window.usedPct >= 100) ||
    (typeof window.remainingPct === "number" && window.remainingPct <= 0);
}

/**
 * The latest reset among the exhausted windows of the provider's usage entry. Null when no entry
 * is exhausted, or when several accounts of that provider are: the legacy list cannot say which
 * account the agent runs on.
 */
export function exhaustedResetAt(providers: readonly ProviderUsage[], provider: string): string | null {
  const resets = providers.flatMap((entry) => {
    if (entry.providerId !== provider || !Array.isArray(entry.windows)) return [];
    const times = (entry.windows as UsageWindow[])
      .filter((window) => window && exhausted(window) && typeof window.resetsAt === "string")
      .map((window) => Date.parse(window.resetsAt as string))
      .filter((time) => !Number.isNaN(time));
    return times.length ? [Math.max(...times)] : [];
  });
  return resets.length === 1 ? new Date(resets[0] as number).toISOString() : null;
}

/**
 * Asks Paseo's provider usage list once per reader. Usage can be off on the host ("Usage is off on
 * this host."), missing on an old client, or empty; every such case reads as no renewal time.
 */
export function usageResetReader(paseo: PaseoApi): UsageResetReader {
  let list: Promise<readonly ProviderUsage[]> | null = null;
  const load = async (): Promise<readonly ProviderUsage[]> => {
    // `listUsage` is newer than the published client typings.
    const providers = paseo.providers as unknown as { listUsage?: () => Promise<{ providers?: unknown }> };
    if (typeof providers.listUsage !== "function") return [];
    try {
      const result = await providers.listUsage.call(paseo.providers);
      return Array.isArray(result?.providers) ? (result.providers as ProviderUsage[]) : [];
    } catch (error) {
      console.error("[chat-resume] could not list provider usage", error);
      return [];
    }
  };
  return async (provider) => exhaustedResetAt(await (list ??= load()), provider);
}
