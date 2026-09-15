import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import {
  getProfileRoutingSettings,
  ProfileRoutingSettingsSchema,
  setProfileRoutingSettings,
  type ProfileRoutingSettings,
} from "../shared/settings";

const QUERY_KEY = ["profile-routing", "settings"] as const;
const SCRIPT_EXAMPLE = `echo '{"provider":"claude","model":"claude-opus-5","modeId":"auto","thinkingOptionId":"$EFFORT"}'`;
const SCRIPT_HINT = `The command must print JSON for the delegate, for example:\n${SCRIPT_EXAMPLE}`;

type DraftModel = { key: string; id: string; script: string };
type Draft = {
  relayTimeoutMinutes: string;
  archiveDelaySeconds: string;
  models: DraftModel[];
};

function toDraft(settings: ProfileRoutingSettings): Draft {
  return {
    relayTimeoutMinutes: String(settings.relayTimeoutMinutes),
    archiveDelaySeconds: String(settings.archiveDelaySeconds),
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
    models: draft.models.map(({ id, script }) => ({ id, script })),
  });
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
  const saveSettings = useRpc(setProfileRoutingSettings);
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
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        title="Models"
        info="Each model is a catalog id plus a shell command. The command runs with EFFORT from the thinking option (min maps to low)."
      >
        {draft.models.map((model, index) => (
          <SettingsCard key={model.key}>
            <SettingsInput
              label="Id"
              initialValue={model.id}
              onChangeText={(id) =>
                setDraft((current) => ({
                  ...current,
                  models: current.models.map((entry, entryIndex) =>
                    entryIndex === index ? { ...entry, id } : entry,
                  ),
                }))
              }
              disabled={mutation.isPending}
              error={issue("models", index, "id") ?? (index === 0 ? issue("models") : null)}
            />
            <ScriptInput
              compact={layout.compact}
              disabled={mutation.isPending}
              error={issue("models", index, "script")}
              theme={theme}
              value={model.script}
              onChangeText={(script) =>
                setDraft((current) => ({
                  ...current,
                  models: current.models.map((entry, entryIndex) =>
                    entryIndex === index ? { ...entry, script } : entry,
                  ),
                }))
              }
            />
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
        ))}
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
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.foreground }]}>Script</Text>
      <TextInput
        accessibilityLabel="Script"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        multiline
        numberOfLines={compact ? 6 : 8}
        onChangeText={onChangeText}
        placeholder={SCRIPT_EXAMPLE}
        placeholderTextColor={colors.foregroundMuted}
        selectionColor={colors.accent}
        spellCheck={false}
        style={[
          styles.textarea,
          {
            minHeight: compact ? 132 : 176,
            borderColor: error ? colors.statusDanger : colors.border,
            backgroundColor: colors.surface0,
            color: colors.foreground,
            opacity: disabled ? 0.5 : 1,
          },
        ]}
        textAlignVertical="top"
        value={value}
      />
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
  field: { gap: 6, paddingVertical: 4 },
  label: { fontSize: 13, fontWeight: "600" },
  textarea: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    lineHeight: 22,
    fontFamily: "monospace",
  },
  hint: { fontSize: 12, lineHeight: 18 },
});

