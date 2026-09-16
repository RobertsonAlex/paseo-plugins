import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { AgentConfigSchema } from "./agent-call";

export const DEFAULT_PROFILE_ROUTING_SETTINGS = {
  relayTimeoutMinutes: 120,
  archiveDelaySeconds: 3,
  archiveWhenDelegatesArchived: true,
  archiveWorkspaceWhenEmpty: true,
  models: [
    {
      id: "claude",
      script: `echo '{"provider":"claude","model":"claude-opus-5","modeId":"auto","thinkingOptionId":"$EFFORT"}'`,
    },
  ],
};

const ModelIdSchema = z
  .string()
  .trim()
  .min(1, "Enter a model id.")
  .max(64, "The model id is too long.")
  .regex(/^[a-z][a-z0-9-]*$/, "Use a lowercase id such as agent or claude.");

export const ProfileRoutingSettingsSchema = z.object({
  relayTimeoutMinutes: z.coerce
    .number()
    .int()
    .positive("Relay timeout must be at least 1 minute."),
  archiveDelaySeconds: z.coerce
    .number()
    .int()
    .nonnegative("Archive delay cannot be negative."),
  archiveWhenDelegatesArchived: z.boolean().default(true),
  archiveWorkspaceWhenEmpty: z.boolean().default(true),
  models: z
    .array(
      z.object({
        id: ModelIdSchema,
        script: z.string().trim().min(1, "Enter a shell command.").max(8_192, "The script is too long."),
      }),
    )
    .min(1, "Add at least one model.")
    .superRefine((models, context) => {
      const seen = new Set<string>();
      for (const [index, model] of models.entries()) {
        if (seen.has(model.id)) {
          context.addIssue({
            code: "custom",
            message: "Model ids must be unique.",
            path: [index, "id"],
          });
        }
        seen.add(model.id);
      }
    }),
});

export type ProfileRoutingSettings = z.infer<typeof ProfileRoutingSettingsSchema>;

export const getProfileRoutingSettings = defineRpc({
  name: "profile-routing.settings.get",
  input: z.object({}),
  output: ProfileRoutingSettingsSchema,
});

export const setProfileRoutingSettings = defineRpc({
  name: "profile-routing.settings.set",
  input: ProfileRoutingSettingsSchema,
  output: ProfileRoutingSettingsSchema,
});

export const ScriptTestResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    provider: z.string().min(1),
    config: AgentConfigSchema,
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1),
  }),
]);

export type ScriptTestResult = z.infer<typeof ScriptTestResultSchema>;

export const testProfileRoutingScript = defineRpc({
  name: "profile-routing.settings.test",
  input: z.object({
    script: z.string().min(1, "Enter a shell command.").max(8_192, "The script is too long."),
  }),
  output: ScriptTestResultSchema,
});
