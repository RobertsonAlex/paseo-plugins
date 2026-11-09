import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  forgetTurnOutput,
  inspectAgents,
  rememberTurnEnded,
  turnEndedTimeline,
} from "./server/inspect-usage";
import { cancelAgentResume, scheduleAgentResume } from "./server/schedule-resume";
import { addTurnHooks } from "./server/turn-hooks";
import { cancelResumeRpc, inspectUsageRpc, scheduleResumeRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const stopTurnHooks = addTurnHooks(server, {
    before: (event) => forgetTurnOutput(event.agent.id),
    after: async (event, { paseo }) => {
      if (event.outcome.kind === "canceled") {
        forgetTurnOutput(event.agent.id);
        return;
      }
      rememberTurnEnded({ ...event, timeline: await turnEndedTimeline(event.agent.id, paseo) });
    },
  });
  server.handle(inspectUsageRpc, inspectAgents);
  server.handle(scheduleResumeRpc, scheduleAgentResume);
  server.handle(cancelResumeRpc, cancelAgentResume);
  return stopTurnHooks;
}
