import type { PluginHookContext, PluginHookEvents, PluginServerContext } from "@getpaseo/plugin/server";

export interface TurnHandlers {
  before(event: PluginHookEvents["agent.turn.before"], context: PluginHookContext): void | Promise<void>;
  after(event: PluginHookEvents["agent.turn.after"], context: PluginHookContext): void | Promise<void>;
}

/** Registers turn start/end handlers with `addHook` on Paseo 0.15+, else the 0.14 `on` names. */
export function addTurnHooks(server: Pick<PluginServerContext, "addHook" | "on">, handlers: TurnHandlers): () => void {
  let stops: (() => void)[] = [];
  if (typeof server.addHook === "function") {
    stops = [
      server.addHook("agent.turn.before", async (event, context) => handlers.before(event, context)),
      server.addHook("agent.turn.after", async (event, context) => handlers.after(event, context)),
    ];
  } else if (typeof server.on === "function") {
    stops = [
      server.on("agent.turn_started", handlers.before),
      server.on("agent.turn_ended", handlers.after),
    ];
  }
  return () => {
    for (const stop of stops) stop();
  };
}
