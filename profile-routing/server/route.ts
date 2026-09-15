import {
  pickForEffort,
  type CreateAgentArguments,
  type EffortId,
  type PickPaseo,
  type PickResult,
} from "./model-pick";

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

export interface RoutingPaseo extends PickPaseo {
  agents: {
    ref(id: string): RouterHandle;
  };
  workspaces: {
    ref(id: string): {
      agents: {
        create(options: {
          config: {
            provider: string;
            modeId?: string;
            thinkingOptionId?: string;
            featureValues?: Record<string, unknown>;
          };
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

export function routingNote(
  profileName: string,
  call: CreateAgentArguments,
  delegateId: string,
): string {
  return `Routing to ${profileName} (${call.provider}/${call.model}) as ${delegateId}.`;
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

function providerModel(call: CreateAgentArguments): string {
  return `${call.provider}/${call.model}`;
}

export async function* routeMessage(options: {
  paseo: RoutingPaseo;
  routerAgentId: string;
  mode: RouteMode;
  effort: EffortId;
  text: string;
  timeouts: { relayTimeoutMs: number; archiveDelayMs: number };
  signal?: AbortSignal;
  pickForEffort?: typeof pickForEffort;
  delay?: (ms: number) => Promise<void>;
}): AsyncGenerator<RouteEvent, void> {
  const pick = options.pickForEffort ?? pickForEffort;
  throwIfAborted(options.signal);
  const workspaceId = await workspaceIdOf(options.paseo, options.routerAgentId);
  throwIfAborted(options.signal);
  if (!workspaceId) throw new RouteFailure("Router agent has no workspace");

  const chosen: PickResult = await pick(options.paseo, options.effort);
  throwIfAborted(options.signal);
  if ("none" in chosen) throw new RouteFailure(chosen.none);

  const delegate = await options.paseo.workspaces.ref(workspaceId).agents.create({
    config: {
      provider: providerModel(chosen.call),
      modeId: chosen.call.modeId,
      thinkingOptionId: chosen.call.thinkingOptionId,
      featureValues: chosen.call.featureValues,
    },
    prompt: options.text,
    title: delegateTitle(chosen.profile.name, options.text),
    labels: {
      [ROUTER_LABEL]: options.routerAgentId,
      [PROFILE_LABEL]: chosen.profile.name,
    },
  });
  yield {
    type: "note",
    text: routingNote(chosen.profile.name, chosen.call, delegate.id),
  };

  if (options.mode === "handoff") {
    void (options.delay ?? delay)(options.timeouts.archiveDelayMs).then(() =>
      options.paseo.agents.ref(options.routerAgentId).archive(),
    );
    return;
  }
  if (options.mode === "detach") return;

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
