import { z } from "zod";

// Paseo's agent session config, as agents.create({ config }) accepts it: a joined
// "claude/opus-5" provider, or a bare "claude" provider with model as its own field.
export const AgentConfigSchema = z
  .object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1).optional(),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    featureValues: z.record(z.string(), z.unknown()).optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    systemPrompt: z.string().optional(),
    title: z.string().optional(),
    mcpServers: z.unknown().optional(),
    toolPolicy: z.unknown().optional(),
  })
  .strip();

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function providerLabel(config: AgentConfig): string {
  return config.model && !config.provider.includes("/")
    ? `${config.provider}/${config.model}`
    : config.provider;
}
