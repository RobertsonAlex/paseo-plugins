import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderContent,
  type ProviderRegistration,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_PROFILE_ROUTING_SETTINGS,
  type ProfileRoutingSettings,
} from "../shared/settings";
import { EFFORT_IDS, pickFromScript, type EffortId } from "./pick";
import { RouteCanceled, RouteFailure, routeMessage, type RouteMode, type RoutingPaseo } from "./route";

const CAPABILITIES = [
  "prompt.message",
  "session.persistence",
  "session.configure",
  "session.archive",
  "session.unarchive",
] as const;

const MODE_IDS = ["relay", "handoff", "detach"] as const;
const MODE_SET = new Set<string>(MODE_IDS);
const EFFORT_SET = new Set<string>(EFFORT_IDS);

const MODES = [
  {
    id: "relay",
    label: "Relay",
    description: "Wait for the delegate and relay its answer as this turn",
  },
  {
    id: "handoff",
    label: "Handoff",
    description: "Start the delegate, end this turn, then archive this router",
  },
  {
    id: "detach",
    label: "Detach",
    description: "Start the delegate and end this turn without waiting",
  },
];

const THINKING = [
  { id: "min", label: "Min" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
];

function catalogFrom(settings: ProfileRoutingSettings): ProviderCatalog {
  const models = settings.models.map((model) => ({ id: model.id, label: model.id }));
  return {
    models,
    modes: MODES,
    thinkingOptions: THINKING,
    defaultModel: models[0]?.id,
    defaultMode: "relay",
    defaultThinkingOption: "medium",
  };
}

function timeoutsFrom(settings: ProfileRoutingSettings): {
  relayTimeoutMs: number;
  archiveDelayMs: number;
} {
  return {
    relayTimeoutMs: settings.relayTimeoutMinutes * 60_000,
    archiveDelayMs: settings.archiveDelaySeconds * 1_000,
  };
}

function isMode(value: string | undefined): value is RouteMode {
  return value !== undefined && MODE_SET.has(value);
}

function isEffort(value: string | undefined): value is EffortId {
  return value !== undefined && EFFORT_SET.has(value);
}

function asMode(value: string | undefined): RouteMode {
  return isMode(value) ? value : "relay";
}

function asEffort(value: string | undefined): EffortId {
  return isEffort(value) ? value : "medium";
}

function asModel(value: string | undefined, settings: ProfileRoutingSettings): string {
  if (value && settings.models.some((model) => model.id === value)) return value;
  return settings.models[0]?.id ?? "";
}

function promptText(content: ProviderContent[]): string {
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return part.type === "text" && "text" in part && typeof part.text === "string";
    })
    .map((part) => part.text)
    .join("\n");
}

interface RouterSession {
  config: ProviderSessionConfig;
  persistence: ProviderPersistence;
  routerAgentId: string | null;
  activeTurn: { turnId: string; abort: AbortController } | null;
}

export function createProfileRoutingProvider(options: {
  getPaseo: () => RoutingPaseo | undefined;
  readSettings: () => Promise<ProfileRoutingSettings>;
}): ProviderRegistration {
  return {
    id: "profile-routing",
    label: "Profile routing",
    description: "Routes each prompt through a configured model script, then relays or detaches",
    icon: "icon.svg",
    async getCatalogCacheKey() {
      const settings = await options.readSettings();
      return settings.models.map((model) => model.id).join(",");
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection(
        negotiateProviderCapabilities(request.capabilities, CAPABILITIES),
        options,
      );
    },
  };
}

function createConnection(
  capabilities: readonly string[],
  options: {
    getPaseo: () => RoutingPaseo | undefined;
    readSettings: () => Promise<ProfileRoutingSettings>;
  },
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, RouterSession>();
  let settings = DEFAULT_PROFILE_ROUTING_SETTINGS;
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };
  const refreshSettings = async () => {
    settings = await options.readSettings();
    return settings;
  };

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      validateAdmission(input, sessions, capabilities);
      if (input.type === "session.prompt") {
        admitPrompt(input, { sessions, emit, getPaseo: options.getPaseo, readSettings: refreshSettings });
        return;
      }
      if (input.type === "session.interrupt") {
        sessions.get(input.sessionId)?.activeTurn?.abort.abort();
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      queueMicrotask(() => {
        if (!closed) {
          void dispatch(input, {
            sessions,
            emit,
            capabilities,
            settings: () => settings,
            refreshSettings,
          });
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const session of sessions.values()) session.activeTurn?.abort.abort();
      sessions.clear();
      listeners.clear();
    },
  };
}

function validateAdmission(
  input: ProviderInput,
  sessions: Map<string, RouterSession>,
  capabilities: readonly string[],
): void {
  if (input.type === "session.open") {
    if (sessions.has(input.sessionId)) throw new Error(`Session already exists: ${input.sessionId}`);
    requireProviderCapabilities(capabilities, input);
    return;
  }
  if (!("sessionId" in input)) {
    requireProviderCapabilities(capabilities, input);
    return;
  }
  if (!sessions.has(input.sessionId)) throw new Error(`Unknown session: ${input.sessionId}`);
  requireProviderCapabilities(capabilities, input);
}

interface ConnectionState {
  sessions: Map<string, RouterSession>;
  emit(event: ProviderEvent): void;
  capabilities: readonly string[];
  settings(): ProfileRoutingSettings;
  refreshSettings(): Promise<ProfileRoutingSettings>;
}

async function dispatch(input: ProviderInput, state: ConnectionState): Promise<void> {
  switch (input.type) {
    case "catalog": {
      const settings = await state.refreshSettings();
      state.emit({
        type: "catalog",
        requestId: input.requestId,
        catalog: catalogFrom(settings),
      });
      return;
    }
    case "sessions":
      state.emit({ type: "sessions", requestId: input.requestId, sessions: [] });
      return;
    case "session.open":
      await openSession(input, state);
      return;
    case "session.configure":
      configureSession(input, state);
      return;
    case "session.archive":
    case "session.unarchive":
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    case "session.close":
      state.sessions.get(input.sessionId)?.activeTurn?.abort.abort();
      state.sessions.delete(input.sessionId);
      state.emit({ type: "session.closed", sessionId: input.sessionId });
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    default:
      break;
  }
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: ConnectionState,
): Promise<void> {
  const settings = await state.refreshSettings();
  const persistence = input.persistence ?? { version: 1, data: {} };
  const session: RouterSession = {
    config: {
      ...input.config,
      model: asModel(input.config.model, settings),
      mode: asMode(input.config.mode),
      thinkingOption: asEffort(input.config.thinkingOption),
    },
    persistence,
    routerAgentId: input.config.env.PASEO_AGENT_ID ?? null,
    activeTurn: null,
  };
  state.sessions.set(input.sessionId, session);
  state.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: state.capabilities,
    restoration: "core",
    persistence,
    title: input.config.title,
    cwd: input.config.cwd,
  });
  state.emit({ type: "session.config", sessionId: input.sessionId, config: configState(session, settings) });
  state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
}

function admitPrompt(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: Pick<ConnectionState, "sessions" | "emit"> & {
    getPaseo: () => RoutingPaseo | undefined;
    readSettings: () => Promise<ProfileRoutingSettings>;
  },
): void {
  const session = state.sessions.get(input.sessionId);
  if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
  if (input.prompt.delivery === "steer" || input.prompt.input.type !== "message") {
    state.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "Profile routing only accepts message prompts" } },
    });
    return;
  }

  const text = promptText(input.prompt.input.content);
  const turnId = randomUUID();
  session.activeTurn?.abort.abort();
  session.activeTurn = { turnId, abort: new AbortController() };
  state.emit({
    type: "timeline.item",
    sessionId: input.sessionId,
    item: {
      type: "user_message",
      id: `user:${turnId}`,
      text,
      clientMessageId: input.prompt.clientMessageId,
    },
  });
  state.emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "turn", turnId },
  });
  state.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
  void runTurn(input.sessionId, turnId, text, state);
}

async function runTurn(
  sessionId: string,
  turnId: string,
  text: string,
  state: Pick<ConnectionState, "sessions" | "emit"> & {
    getPaseo: () => RoutingPaseo | undefined;
    readSettings: () => Promise<ProfileRoutingSettings>;
  },
): Promise<void> {
  const session = state.sessions.get(sessionId);
  if (!session || session.activeTurn?.turnId !== turnId) return;
  const fail = (message: string) => {
    if (session.activeTurn?.turnId !== turnId) return;
    state.emit({
      type: "session.turn",
      sessionId,
      turnId,
      state: "failed",
      error: { message },
    });
    session.activeTurn = null;
  };

  const paseo = state.getPaseo();
  if (!paseo) {
    fail("Profile routing is not connected to the Paseo SDK yet");
    return;
  }
  if (!session.routerAgentId) {
    fail("PASEO_AGENT_ID is missing from the session environment");
    return;
  }

  const settings = await state.readSettings();
  const modelId = asModel(session.config.model, settings);
  const spec = settings.models.find((model) => model.id === modelId);
  if (!spec) {
    fail("No models are configured in Profile routing settings");
    return;
  }

  try {
    for await (const event of routeMessage({
      paseo,
      routerAgentId: session.routerAgentId,
      modelId: spec.id,
      mode: asMode(session.config.mode),
      effort: asEffort(session.config.thinkingOption),
      text,
      timeouts: timeoutsFrom(settings),
      signal: session.activeTurn.abort.signal,
      pick: (_id, effort) =>
        pickFromScript({ script: spec.script, effort, cwd: session.config.cwd }),
    })) {
      if (session.activeTurn?.turnId !== turnId) return;
      if (event.type === "note") {
        state.emit({
          type: "timeline.item",
          sessionId,
          item: {
            type: "notification",
            id: `note:${turnId}`,
            level: "info",
            message: event.text,
          },
        });
        continue;
      }
      state.emit({
        type: "timeline.item",
        sessionId,
        item: {
          type: "assistant_message",
          id: `assistant:${turnId}:final`,
          text: event.text,
        },
      });
    }
    if (session.activeTurn?.turnId !== turnId) return;
    state.emit({ type: "session.turn", sessionId, turnId, state: "completed" });
    session.activeTurn = null;
  } catch (error) {
    if (error instanceof RouteCanceled) {
      state.emit({ type: "session.turn", sessionId, turnId, state: "canceled" });
      if (session.activeTurn?.turnId === turnId) session.activeTurn = null;
      return;
    }
    if (session.activeTurn?.turnId !== turnId) return;
    const message =
      error instanceof RouteFailure
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    fail(message);
  }
}

function configureSession(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  state: ConnectionState,
): void {
  const session = state.sessions.get(input.sessionId);
  if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
  const settings = state.settings();
  const changes = input.changes;
  session.config = {
    ...session.config,
    model:
      changes.model === null
        ? asModel(undefined, settings)
        : asModel(changes.model ?? session.config.model, settings),
    mode: changes.mode === null ? "relay" : asMode(changes.mode ?? session.config.mode),
    thinkingOption:
      changes.thinkingOption === null
        ? "medium"
        : asEffort(changes.thinkingOption ?? session.config.thinkingOption),
    settings: changes.settings
      ? { ...session.config.settings, ...changes.settings }
      : session.config.settings,
  };
  state.emit({ type: "session.config", sessionId: input.sessionId, config: configState(session, settings) });
  state.emit({ type: "request.completed", requestId: input.requestId });
}

function configState(session: RouterSession, settings: ProfileRoutingSettings): ProviderConfigState {
  const catalog = catalogFrom(settings);
  return {
    model: asModel(session.config.model, settings),
    mode: asMode(session.config.mode),
    thinkingOption: asEffort(session.config.thinkingOption),
    models: catalog.models,
    modes: catalog.modes,
    thinkingOptions: catalog.thinkingOptions ?? THINKING,
    settings: [],
  };
}
