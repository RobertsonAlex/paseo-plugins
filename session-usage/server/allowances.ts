import { AllowanceWindowSchema, ProviderAllowanceSchema, type Allowances } from "../shared/allowance";
import { object } from "./parser";

type UsageLister = { listUsage?: (options?: { forceRefresh?: boolean }) => Promise<unknown> };

/**
 * Subscription allowances as Paseo reports them. Paseo's daemon queries the provider accounts and
 * caches the result; this plugin never contacts a provider. Invalid entries are dropped one by one.
 */
export async function readAllowances(paseo: { providers: object }, refresh: boolean): Promise<Allowances> {
  // `listUsage` is newer than the published client typings.
  const providers = paseo.providers as UsageLister;
  if (typeof providers.listUsage !== "function") return { fetchedAt: null, providers: [], error: "Update Paseo to show subscription allowances." };
  try {
    const result = object(await providers.listUsage.call(paseo.providers, { forceRefresh: refresh }));
    const list = Array.isArray(result.providers) ? result.providers : [];
    return {
      fetchedAt: typeof result.fetchedAt === "string" ? result.fetchedAt : null,
      providers: list.flatMap((raw) => {
        const entry = object(raw);
        const windows = (Array.isArray(entry.windows) ? entry.windows : []).flatMap((window) => {
          const parsed = AllowanceWindowSchema.safeParse(window);
          return parsed.success ? [parsed.data] : [];
        });
        const parsed = ProviderAllowanceSchema.safeParse({ ...entry, windows });
        return parsed.success ? [parsed.data] : [];
      }),
      error: null,
    };
  } catch (error) {
    return { fetchedAt: null, providers: [], error: `Paseo could not report subscription allowances: ${error instanceof Error ? error.message : String(error)}` };
  }
}
