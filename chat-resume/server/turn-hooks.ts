import type { PluginHookContext, PluginHookEvents, PluginServerContext } from "@getpaseo/plugin/server";

export interface TurnHandlers {
  before(event: PluginHookEvents["agent.turn.before"], context: PluginHookContext): void | Promise<void>;
  after(event: PluginHookEvents["agent.turn.after"], context: PluginHookContext): void | Promise<void>;
}

/** Registers turn start/end handlers with `addHook`. */
export function addTurnHooks(server: Pick<PluginServerContext, "addHook">, handlers: TurnHandlers): () => void {
  const stops = [
    server.addHook("agent.turn.before", async (event, context) => handlers.before(event, context)),
    server.addHook("agent.turn.after", async (event, context) => handlers.after(event, context)),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
