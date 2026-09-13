import { type PluginButtonContentProps, usePaseo } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import type {
  PaseoAgent,
  PaseoProviderModelsResult,
  PaseoProviderModesResult,
  PaseoProviderSnapshotResult,
} from "@getpaseo/client";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  buildHandoverPrompt,
  HANDOVER_SOURCE_LABEL,
  readyHandoverProviders,
  similarMode,
  similarThinkingOption,
} from "../shared/handover";

type ProviderEntry = PaseoProviderSnapshotResult["entries"][number];
type Model = NonNullable<PaseoProviderModelsResult["models"]>[number];
type Mode = NonNullable<PaseoProviderModesResult["modes"]>[number];

interface ProviderCatalog {
  models: Model[];
  modes: Mode[];
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function HandoverModal(props: PluginButtonContentProps) {
  const { close, theme } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const paseo = usePaseo();
  const toast = useToast();
  const colors = theme.colors;
  const [open, setOpen] = useState(true);
  const [source, setSource] = useState<PaseoAgent | null>(null);
  const [providers, setProviders] = useState<ProviderEntry[]>([]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, ProviderCatalog>>({});
  const [modelId, setModelId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    void (async () => {
      try {
        const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
        if (!agent) throw new Error(`Agent not found: ${agentId}`);
        const snapshot = await paseo.providers.waitForReady({ cwd: agent.cwd, timeoutMs: 15_000 });
        if (cancelled) return;
        const ready = readyHandoverProviders(snapshot.entries, agent.provider);
        setSource(agent);
        setPrompt(buildHandoverPrompt(agent.id));
        setProviders(ready);
        setProviderId(ready[0]?.provider ?? null);
        if (ready.length === 0) setError("No other ready provider is available.");
      } catch (cause) {
        if (!cancelled) setError(message(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, paseo]);

  const provider = providers.find((entry) => entry.provider === providerId) ?? null;
  const catalog = providerId ? catalogs[providerId] : undefined;

  useEffect(() => {
    if (!provider || !source || catalogs[provider.provider]) return;
    let cancelled = false;
    void (async () => {
      try {
        const [modelsResult, modesResult] = await Promise.all([
          provider.models?.length
            ? { models: provider.models, error: null }
            : paseo.providers.listModels(provider.provider, { cwd: source.cwd }),
          provider.modes?.length
            ? { modes: provider.modes, error: null }
            : paseo.providers.listModes(provider.provider, { cwd: source.cwd }),
        ]);
        if (modelsResult.error) throw new Error(modelsResult.error);
        if (modesResult.error) throw new Error(modesResult.error);
        if (cancelled) return;
        const models = (modelsResult.models ?? []).filter((model) => model.isSelectable !== false);
        setCatalogs((current) => ({
          ...current,
          [provider.provider]: { models, modes: modesResult.modes ?? [] },
        }));
      } catch (cause) {
        if (!cancelled) setError(message(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [catalogs, paseo, provider, source]);

  useEffect(() => {
    if (!catalog) return;
    setModelId((current) =>
      catalog.models.some((model) => model.id === current)
        ? current
        : (catalog.models.find((model) => model.isDefault) ?? catalog.models[0])?.id ?? null,
    );
  }, [catalog]);

  const model = catalog?.models.find((candidate) => candidate.id === modelId) ?? null;
  const modeId = useMemo(
    () =>
      source && catalog && provider
        ? similarMode(source.currentModeId, catalog.modes, provider.defaultModeId)
        : undefined,
    [catalog, provider, source],
  );
  const thinkingOptionId = useMemo(
    () =>
      source && model
        ? (similarThinkingOption(
            source.effectiveThinkingOptionId ?? source.thinkingOptionId,
            model.thinkingOptions ?? [],
          ) ?? model.defaultThinkingOptionId)
        : undefined,
    [model, source],
  );
  const modeLabel = catalog?.modes.find((mode) => mode.id === modeId)?.label ?? modeId;
  const effortLabel =
    model?.thinkingOptions?.find((option) => option.id === thinkingOptionId)?.label ?? thinkingOptionId;

  function dismiss() {
    setOpen(false);
    close();
  }

  async function send() {
    const text = prompt.trim();
    if (!source?.workspaceId || !provider || !model || !text || sending) return;
    setSending(true);
    setError(null);
    try {
      await paseo.workspaces.ref(source.workspaceId).agents.create({
        config: {
          provider: `${provider.provider}/${model.id}`,
          ...(modeId ? { modeId } : {}),
          ...(thinkingOptionId ? { thinkingOptionId } : {}),
        },
        prompt: text,
        title: `Handover: ${source.title ?? source.id.slice(0, 7)}`,
        labels: { [HANDOVER_SOURCE_LABEL]: source.id },
      });
      toast.show(`Handover started on ${provider.label ?? provider.provider}`, { variant: "success" });
      dismiss();
    } catch (cause) {
      console.error("[chat-resume] could not start handover", source.id, cause);
      setError(message(cause));
      setSending(false);
    }
  }

  const canSend = Boolean(source?.workspaceId && provider && model && prompt.trim()) && !sending;

  return (
    <Modal
      title="Handover"
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <Modal.Content>
        <View style={styles.body}>
          <Text style={[styles.label, { color: colors.foregroundMuted }]}>Continuation prompt</Text>
          <TextInput
            accessibilityLabel="Handover prompt"
            editable={!sending}
            multiline
            onChangeText={setPrompt}
            placeholder={loading ? "Loading handover context…" : "Prompt for the new agent"}
            placeholderTextColor={colors.foregroundMuted}
            selectionColor={colors.accent}
            style={[
              styles.input,
              { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface1 },
            ]}
            textAlignVertical="top"
            value={prompt}
          />

          <Text style={[styles.label, { color: colors.foregroundMuted }]}>Provider</Text>
          <ChipRow
            colors={colors}
            disabled={sending}
            options={providers.map((entry) => ({ id: entry.provider, label: entry.label ?? entry.provider }))}
            selectedId={providerId}
            onSelect={setProviderId}
            placeholder={loading ? "Loading providers…" : "No ready providers"}
          />

          <Text style={[styles.label, { color: colors.foregroundMuted }]}>Model</Text>
          <ChipRow
            colors={colors}
            disabled={sending}
            options={(catalog?.models ?? []).map((entry) => ({ id: entry.id, label: entry.label }))}
            selectedId={modelId}
            onSelect={setModelId}
            placeholder={provider && !catalog ? "Loading models…" : "No selectable models"}
          />

          {model ? (
            <Text style={[styles.hint, { color: colors.foregroundMuted }]}>
              Mode: {modeLabel ?? "default"} · Effort: {effortLabel ?? "default"}
            </Text>
          ) : null}
          {error ? <Text style={[styles.hint, { color: colors.statusDanger }]}>{error}</Text> : null}

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={dismiss}
              style={({ pressed }) => [
                styles.button,
                { borderColor: colors.border, borderWidth: 1, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={[styles.buttonText, { color: colors.foreground }]}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send handover prompt to a new agent"
              disabled={!canSend}
              onPress={() => void send()}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.accent, opacity: !canSend || pressed ? 0.6 : 1 },
              ]}
            >
              <Text style={[styles.buttonText, { color: colors.accentForeground }]}>
                {sending ? "Sending…" : "Send"}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

function ChipRow({
  colors,
  disabled,
  options,
  selectedId,
  onSelect,
  placeholder,
}: {
  colors: PluginButtonContentProps["theme"]["colors"];
  disabled: boolean;
  options: { id: string; label: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  placeholder: string;
}) {
  if (options.length === 0) {
    return <Text style={[styles.hint, { color: colors.foregroundMuted }]}>{placeholder}</Text>;
  }
  return (
    <View style={styles.chips}>
      {options.map((option) => {
        const selected = option.id === selectedId;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onSelect(option.id)}
            style={({ pressed }) => [
              styles.chip,
              {
                borderColor: selected ? colors.accent : colors.border,
                backgroundColor: selected ? colors.accent : colors.surface1,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Text style={[styles.chipText, { color: selected ? colors.accentForeground : colors.foreground }]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: 10,
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
  },
  input: {
    borderRadius: 8,
    borderWidth: 1,
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 19,
    minHeight: 200,
    padding: 12,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: {
    fontSize: 13,
  },
  hint: {
    fontSize: 13,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
    justifyContent: "flex-end",
    marginTop: 4,
  },
  button: {
    alignItems: "center",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 16,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
