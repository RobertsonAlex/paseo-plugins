import { providerLabel, type AgentConfig, type EffortId } from "./pick";

export type RouteMode = "relay" | "handoff" | "detach";

export type FinishStatus = "idle" | "error" | "permission" | "timeout";

export interface FinishResult {
  status: FinishStatus;
  lastMessage: string | null;
  error: string | null;
}

export interface DelegateHandle {
  id: string;
  waitForFinish(timeoutMs?: number): Promise<FinishResult>;
}

export interface RouterHandle {
  workspaceId: string | null;
  refresh(): Promise<{ agent: { workspaceId?: string | null } } | null>;
  archive(): Promise<{ archivedAt: string }>;
}

export type { AgentConfig };

export interface RoutingPaseo {
  agents: {
    ref(id: string): RouterHandle;
  };
  workspaces: {
    ref(id: string): {
      agents: {
        create(options: {
          config: AgentConfig;
          prompt: string;
          title: string;
          labels: Record<string, string>;
        }): Promise<DelegateHandle>;
      };
    };
  };
}

export type RouteEvent =
  | { type: "note"; text: string }
  | { type: "final"; text: string };

export class RouteFailure extends Error {
  readonly code = "route_failed";
  constructor(message: string) {
    super(message);
    this.name = "RouteFailure";
  }
}

export class RouteCanceled extends Error {
  readonly code = "route_canceled";
  constructor() {
    super("Routing was interrupted");
    this.name = "RouteCanceled";
  }
}

export const ROUTER_LABEL = "profile-routing.router";
export const PROFILE_LABEL = "profile-routing.profile";

export function delegateTitle(profileName: string, text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const composed = `${profileName}: ${line}`;
  return composed.length <= 60 ? composed : `${composed.slice(0, 59)}…`;
}

export function routingNote(modelId: string, provider: string, delegateId: string): string {
  return `Routing to ${modelId} (${provider}) as ${delegateId}.`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RouteCanceled();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWithAbort(
  handle: DelegateHandle,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<FinishResult | { status: "interrupted" }> {
  if (signal?.aborted) return { status: "interrupted" };
  return await new Promise((resolve, reject) => {
    const onAbort = () => resolve({ status: "interrupted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    handle.waitForFinish(timeoutMs).then(
      (result) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function workspaceIdOf(paseo: RoutingPaseo, routerAgentId: string): Promise<string | null> {
  const handle = paseo.agents.ref(routerAgentId);
  const refreshed = await handle.refresh();
  return handle.workspaceId ?? refreshed?.agent.workspaceId ?? null;
}

export async function* routeMessage(options: {
  paseo: RoutingPaseo;
  routerAgentId: string;
  modelId: string;
  mode: RouteMode;
  effort: EffortId;
  text: string;
  timeouts: { relayTimeoutMs: number; archiveDelayMs: number };
  pick: (modelId: string, effort: EffortId) => Promise<AgentConfig>;
  signal?: AbortSignal;
  delay?: (ms: number) => Promise<void>;
}): AsyncGenerator<RouteEvent, void> {
  throwIfAborted(options.signal);
  const workspaceId = await workspaceIdOf(options.paseo, options.routerAgentId);
  throwIfAborted(options.signal);
  if (!workspaceId) throw new RouteFailure("Router agent has no workspace");

  let config: AgentConfig;
  try {
    config = await options.pick(options.modelId, options.effort);
  } catch (error) {
    throw error instanceof RouteFailure
      ? error
      : new RouteFailure(error instanceof Error ? error.message : String(error));
  }
  throwIfAborted(options.signal);

  const provider = providerLabel(config);
  const delegate = await options.paseo.workspaces.ref(workspaceId).agents.create({
    config,
    prompt: options.text,
    title: config.title ?? delegateTitle(options.modelId, options.text),
    labels: {
      [ROUTER_LABEL]: options.routerAgentId,
      [PROFILE_LABEL]: options.modelId,
    },
  });
  const note = routingNote(options.modelId, provider, delegate.id);
  yield { type: "note", text: note };

  if (options.mode === "handoff") {
    void (options.delay ?? delay)(options.timeouts.archiveDelayMs)
      .then(() => options.paseo.agents.ref(options.routerAgentId).archive())
      .catch((error) => console.error("profile-routing: archiving the router failed", error));
    yield { type: "final", text: note };
    return;
  }
  if (options.mode === "detach") {
    yield { type: "final", text: note };
    return;
  }

  const finished = await waitWithAbort(delegate, options.timeouts.relayTimeoutMs, options.signal);
  if (finished.status === "interrupted") throw new RouteCanceled();
  if (finished.status === "idle") {
    yield { type: "final", text: finished.lastMessage ?? "" };
    return;
  }
  if (finished.status === "error") {
    throw new RouteFailure(finished.error ?? `Delegate ${delegate.id} failed`);
  }
  if (finished.status === "permission") {
    throw new RouteFailure(
      `Delegate ${delegate.id} is waiting for permission and was left running`,
    );
  }
  throw new RouteFailure(
    `Delegate ${delegate.id} did not finish within the relay timeout and was left running`,
  );
}
