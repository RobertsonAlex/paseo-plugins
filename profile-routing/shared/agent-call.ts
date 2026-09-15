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

// agents.create takes the joined form only: config.provider must read "provider/model".
export type CreateAgentConfig = Omit<AgentConfig, "model">;

export function joinedProvider(config: AgentConfig): string {
  return config.model && !config.provider.includes("/")
    ? `${config.provider}/${config.model}`
    : config.provider;
}

export function createConfig(config: AgentConfig): CreateAgentConfig {
  const { model: _model, ...rest } = config;
  return { ...rest, provider: joinedProvider(config) };
}
