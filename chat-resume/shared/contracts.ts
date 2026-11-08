import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const AgentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "Invalid agent ID");

export const inspectUsageRpc = defineRpc({
  name: "chat-resume.inspect",
  input: z.object({
    agentIds: z.array(AgentIdSchema).min(1).max(200),
  }),
  output: z.object({
    inspections: z.array(
      z.object({
        agentId: z.string(),
        exhausted: z.boolean(),
        resetAt: z.string().nullable(),
        /** The turn stopped mid-work rather than on quota. Never true together with `exhausted`. */
        unfinished: z.boolean(),
        /** A chat-resume heartbeat is pending for the agent; null when the schedule store could not be read. */
        resumeScheduled: z.boolean().nullable(),
      }),
    ),
  }),
});

export const scheduleResumeRpc = defineRpc({
  name: "chat-resume.schedule",
  input: z.object({
    agentId: AgentIdSchema,
  }),
  output: z.object({
    scheduleId: z.string(),
    scheduledFor: z.string(),
  }),
});

export const cancelResumeRpc = defineRpc({
  name: "chat-resume.cancel",
  input: z.object({
    agentId: AgentIdSchema,
  }),
  output: z.object({
    deleted: z.number(),
  }),
});
