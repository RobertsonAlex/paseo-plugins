import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import {
  getProfileRoutingSettings,
  ProfileRoutingSettingsSchema,
  setProfileRoutingSettings,
  testProfileRoutingScript,
  type ProfileRoutingSettings,
  type ScriptTestResult,
} from "../shared/settings";

const QUERY_KEY = ["profile-routing", "settings"] as const;
const SCRIPT_EXAMPLE = `echo '{"provider":"claude","model":"claude-opus-5","modeId":"auto","thinkingOptionId":"$EFFORT"}'`;
const SCRIPT_HINT = `The command must print the agent config Paseo creates agents with. Name a provider and a model, either joined as "claude/claude-opus-5" or with model as its own field; modeId, thinkingOptionId, featureValues, providerOptions, systemPrompt, and title are optional:\n${SCRIPT_EXAMPLE}`;

type DraftModel = { key: string; id: string; script: string };
type Draft = {
  relayTimeoutMinutes: string;
  archiveDelaySeconds: string;
  archiveWhenDelegatesArchived: boolean;
  models: DraftModel[];
};

function toDraft(settings: ProfileRoutingSettings): Draft {
  return {
    relayTimeoutMinutes: String(settings.relayTimeoutMinutes),
    archiveDelaySeconds: String(settings.archiveDelaySeconds),
    archiveWhenDelegatesArchived: settings.archiveWhenDelegatesArchived,
    models: settings.models.map((model, index) => ({
      key: `${model.id}-${index}`,
      id: model.id,
      script: model.script,
    })),
  };
}

function fromDraft(draft: Draft) {
  return ProfileRoutingSettingsSchema.safeParse({
    relayTimeoutMinutes: draft.relayTimeoutMinutes,
    archiveDelaySeconds: draft.archiveDelaySeconds,
    archiveWhenDelegatesArchived: draft.archiveWhenDelegatesArchived,
    models: draft.models.map(({ id, script }) => ({ id, script })),
  });
}

function formatTestResult(result: Extract<ScriptTestResult, { ok: true }>): string {
  return `${result.provider}\n${JSON.stringify(result.config, null, 2)}`;
}

export function SettingsSurface(props: PluginSurfaceProps) {
  const getSettings = useRpc(getProfileRoutingSettings);
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => getSettings({}) });
  if (query.isPending) {
    return <Text style={{ color: props.theme.colors.foreground }}>Loading settings…</Text>;
  }
  if (query.isError) {
    return (
      <SettingsSection title="Profile routing">
        <Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger }}>
          {query.error.message}
        </Text>
        <SettingsAction
          label="Load settings"
          actionLabel="Retry"
          onPress={() => {
            void query.refetch();
          }}
        />
      </SettingsSection>
    );
  }
  return <SettingsEditor {...props} initialSettings={query.data} />;
}

function SettingsEditor({
  host,
  theme,
  layout,
  initialSettings,
}: PluginSurfaceProps & { initialSettings: ProfileRoutingSettings }) {
  const [draft, setDraft] = useState(() => toDraft(initialSettings));
  const [results, setResults] = useState<Record<string, ScriptTestResult>>({});
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const saveSettings = useRpc(setProfileRoutingSettings);
  const testScript = useRpc(testProfileRoutingScript);
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: (settings: ProfileRoutingSettings) => saveSettings(settings),
    onSuccess(settings) {
      queryClient.setQueryData(QUERY_KEY, settings);
      setDraft(toDraft(settings));
      toast.show("Profile routing saved", { variant: "success" });
    },
  });
  const testMutation = useMutation({
    mutationFn: async ({ key, script }: { key: string; script: string }) => {
      return { key, result: await testScript({ script }) };
    },
    onMutate({ key }) {
      setTestingKey(key);
    },
    onSuccess({ key, result }) {
      setResults((current) => ({ ...current, [key]: result }));
    },
    onError(error) {
      toast.error(error instanceof Error ? error.message : String(error));
    },
    onSettled() {
      setTestingKey(null);
    },
  });
  const parsed = fromDraft(draft);
  const issue = (path0: string, path1?: string | number, path2?: string) => {
    if (parsed.success) return null;
    return (
      parsed.error.issues.find((entry) => {
        if (entry.path[0] !== path0) return false;
        if (path1 !== undefined && entry.path[1] !== path1) return false;
        if (path2 !== undefined && entry.path[2] !== path2) return false;
        return true;
      })?.message ?? null
    );
  };
  const updateModel = (index: number, patch: Partial<Pick<DraftModel, "id" | "script">>) => {
    setDraft((current) => ({
      ...current,
      models: current.models.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry,
      ),
    }));
  };

  return (
    <>
      <SettingsSection title="Timeouts">
        <SettingsCard>
          <SettingsInput
            label="Relay timeout (minutes)"
            hint="How long relay waits for the delegate before failing the turn."
            initialValue={draft.relayTimeoutMinutes}
            onChangeText={(relayTimeoutMinutes) =>
              setDraft((current) => ({ ...current, relayTimeoutMinutes }))
            }
            disabled={mutation.isPending}
            error={issue("relayTimeoutMinutes")}
          />
          <SettingsInput
            label="Handoff archive delay (seconds)"
            hint="How long to wait after a handoff turn ends before archiving this router."
            initialValue={draft.archiveDelaySeconds}
            onChangeText={(archiveDelaySeconds) =>
              setDraft((current) => ({ ...current, archiveDelaySeconds }))
            }
            disabled={mutation.isPending}
            error={issue("archiveDelaySeconds")}
          />
          <SettingsSwitch
            label="Archive this router when its delegates are archived"
            hint="When every agent this conversation started has been archived, archive the router too. On by default."
            value={draft.archiveWhenDelegatesArchived}
            onValueChange={(archiveWhenDelegatesArchived) =>
              setDraft((current) => ({ ...current, archiveWhenDelegatesArchived }))
            }
            disabled={mutation.isPending}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        title="Models"
        info="Each model is a catalog id plus a shell command. The command runs with EFFORT from the thinking option (min maps to low)."
      >
        {draft.models.map((model, index) => {
          const result = results[model.key];
          const testing = testingKey === model.key;
          return (
            <SettingsCard key={model.key}>
              <SettingsInput
                label="Id"
                initialValue={model.id}
                onChangeText={(id) => updateModel(index, { id })}
                disabled={mutation.isPending}
                error={issue("models", index, "id") ?? (index === 0 ? issue("models") : null)}
              />
              <ScriptInput
                compact={layout.compact}
                disabled={mutation.isPending}
                error={issue("models", index, "script")}
                theme={theme}
                value={model.script}
                onChangeText={(script) => {
                  updateModel(index, { script });
                  setResults((current) => {
                    if (!(model.key in current)) return current;
                    const next = { ...current };
                    delete next[model.key];
                    return next;
                  });
                }}
              />
              <SettingsAction
                label="Run this script with EFFORT=medium"
                actionLabel={testing ? "Testing…" : "Test"}
                disabled={mutation.isPending || testMutation.isPending || model.script.trim().length === 0}
                onPress={() => testMutation.mutate({ key: model.key, script: model.script })}
              />
              {result ? (
                <SettingsRow
                  label="Test result"
                  hint="Ran with EFFORT=medium. Checks that the output is an agent config with a provider. No agent is created."
                  error={result.ok ? null : result.error}
                >
                  {result.ok ? (
                    <Text
                      selectable
                      style={{
                        color: theme.colors.foreground,
                        fontFamily: "monospace",
                        fontSize: 12,
                        lineHeight: 18,
                      }}
                    >
                      {formatTestResult(result)}
                    </Text>
                  ) : null}
                </SettingsRow>
              ) : null}
              <SettingsAction
                label="Remove this model"
                actionLabel="Remove"
                disabled={mutation.isPending || draft.models.length === 1}
                onPress={() =>
                  setDraft((current) => ({
                    ...current,
                    models: current.models.filter((_, entryIndex) => entryIndex !== index),
                  }))
                }
              />
            </SettingsCard>
          );
        })}
        <SettingsCard>
          <SettingsAction
            label="Add another catalog model"
            actionLabel="Add model"
            disabled={mutation.isPending}
            onPress={() =>
              setDraft((current) => ({
                ...current,
                models: [...current.models, { key: `new-${Date.now()}`, id: "", script: "" }],
              }))
            }
          />
          <SettingsAction
            label="Save profile routing"
            hint={`Applies to agents on ${host.label}. The first model is the catalog default.`}
            actionLabel={mutation.isPending ? "Saving…" : "Save"}
            disabled={!parsed.success || mutation.isPending}
            error={mutation.error?.message}
            onPress={() => {
              if (parsed.success) mutation.mutate(parsed.data);
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

function ScriptInput({
  compact,
  disabled,
  error,
  theme,
  value,
  onChangeText,
}: {
  compact: boolean;
  disabled: boolean;
  error: string | null;
  theme: PluginSurfaceProps["theme"];
  value: string;
  onChangeText(text: string): void;
}) {
  const colors = theme.colors;
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.foreground }]}>Script</Text>
      <View
        style={[
          styles.textareaWrap,
          {
            minHeight: compact ? 148 : 192,
            borderColor: error ? colors.statusDanger : focused ? colors.accent : colors.border,
            backgroundColor: colors.surface0,
            opacity: disabled ? 0.5 : 1,
          },
        ]}
      >
        <TextInput
          accessibilityLabel="Script"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          multiline
          numberOfLines={compact ? 6 : 8}
          onBlur={() => setFocused(false)}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          placeholder={SCRIPT_EXAMPLE}
          placeholderTextColor={colors.foregroundMuted}
          selectionColor={colors.accent}
          spellCheck={false}
          style={[styles.textarea, { color: colors.foreground, outlineWidth: 0 }]}
          textAlignVertical="top"
          value={value}
        />
      </View>
      <Text selectable style={[styles.hint, { color: colors.foregroundMuted }]}>
        {SCRIPT_HINT}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={[styles.hint, { color: colors.statusDanger }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Settings cards leave padding to each row; match the built-in rows above and below.
  field: { gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  label: { fontSize: 13, fontWeight: "600" },
  textareaWrap: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 9,
    padding: 16,
  },
  textarea: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    fontFamily: "monospace",
    padding: 0,
    margin: 0,
  },
  hint: { fontSize: 12, lineHeight: 18 },
});
