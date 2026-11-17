import type { PaseoApi } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { WorkspaceLabelColor } from "../shared/contracts";
import { type ColorScheme, identityForeground, identityTint } from "../shared/colors";
import { type DashWorkspace, dashWorkspaceKey, hasLabel, labelKey } from "../shared/model";
import { describeArchiveRisks } from "./archive-confirm";
import { assignWorkspaceLabel, canAssignLabels } from "./workspace-labels";

/**
 * The bar that appears once rows are selected: how many, and what can be done to all of them at
 * once — add a label, remove a label, archive. A selection can span hosts, so every change goes
 * through the workspace's own host API, one workspace at a time so no daemon is flooded, and the
 * outcome goes to the toast host, which outlives the rows that leave.
 */

const PREVIEW_LIMIT = 8;

/** A label the pickers can offer: its match key, the name to draw and, when known, its color. */
export interface LabelOption {
  key: string;
  name: string;
  color: WorkspaceLabelColor | undefined;
}

export interface BulkActionBarProps {
  /** The selected rows as currently shown; label counts follow them live. */
  selected: readonly DashWorkspace[];
  /** Every label the add picker offers: the catalog plus the labels already on workspaces. */
  labelOptions: readonly LabelOption[];
  theme: PluginTheme;
  scheme: ColorScheme;
  compact: boolean;
  /** Answers null for a host that is no longer connected. */
  resolveApi(serverId: string): PaseoApi | null;
  onClear(): void;
}

type LabelMode = "add" | "remove";

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text && text !== "undefined" ? text : "Something went wrong.";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function useAliveRef() {
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  return aliveRef;
}

export function BulkActionBar({
  selected,
  labelOptions,
  theme,
  scheme,
  compact,
  resolveApi,
  onClear,
}: BulkActionBarProps) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const [labelMode, setLabelMode] = useState<LabelMode | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const count = selected.length;
  const anyLabelled = selected.some((workspace) => workspace.labels.length > 0);

  const dialogs = (
    <>
      {labelMode ? (
        <LabelDialog
          mode={labelMode}
          selected={selected}
          labelOptions={labelOptions}
          theme={theme}
          scheme={scheme}
          resolveApi={resolveApi}
          onClose={() => setLabelMode(null)}
        />
      ) : null}
      {archiveOpen ? (
        <ArchiveDialog
          selected={selected}
          theme={theme}
          resolveApi={resolveApi}
          onClose={() => setArchiveOpen(false)}
        />
      ) : null}
    </>
  );

  // The surface keeps this mounted with an empty selection, and the dialogs sit outside the bar,
  // so an open dialog survives its rows leaving: archiving the last selected workspace must not
  // yank the progress off the screen.
  return (
    <>
      {count > 0 ? (
        <View style={styles.bar} accessibilityRole="toolbar">
          <Text style={styles.count} numberOfLines={1}>
            {count} selected
          </Text>
          <View style={styles.spacer} />
          <BarButton
            icon="Tag"
            label="Add label"
            accessibilityLabel={`Add a label to ${plural(count, "workspace")}`}
            theme={theme}
            styles={styles}
            onPress={() => setLabelMode("add")}
          />
          <BarButton
            icon="Tag"
            label="Remove label"
            accessibilityLabel={`Remove a label from ${plural(count, "workspace")}`}
            disabled={!anyLabelled}
            theme={theme}
            styles={styles}
            onPress={() => setLabelMode("remove")}
          />
          <BarButton
            icon="Archive"
            label="Archive"
            accessibilityLabel={`Archive ${plural(count, "workspace")}`}
            theme={theme}
            styles={styles}
            onPress={() => setArchiveOpen(true)}
          />
          <BarButton
            icon="X"
            label={compact ? null : "Clear"}
            accessibilityLabel="Clear the selection"
            theme={theme}
            styles={styles}
            onPress={onClear}
          />
        </View>
      ) : null}
      {dialogs}
    </>
  );
}

function BarButton({
  icon,
  label,
  accessibilityLabel,
  disabled = false,
  theme,
  styles,
  onPress,
}: {
  icon: string;
  label: string | null;
  accessibilityLabel: string;
  disabled?: boolean;
  theme: PluginTheme;
  styles: BulkStyles;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const color = disabled
    ? theme.colors.foregroundMuted
    : hovered
      ? theme.colors.foreground
      : theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={[
        styles.button,
        hovered && !disabled ? styles.buttonHovered : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Icon name={icon} size={13} color={color} />
      {label ? <Text style={[styles.buttonText, { color }]}>{label}</Text> : null}
    </Pressable>
  );
}

/**
 * Archives exactly the rows that were selected when the dialog opened: rows keep moving between
 * groups while the question is on screen. The dialog names how many go and lists the ones whose
 * worktree still holds unsaved work.
 */
function ArchiveDialog({
  selected,
  theme,
  resolveApi,
  onClose,
}: {
  selected: readonly DashWorkspace[];
  theme: PluginTheme;
  resolveApi(serverId: string): PaseoApi | null;
  onClose(): void;
}) {
  const toast = useToast();
  const styles = useMemo(() => createStyles(theme, false), [theme]);
  const aliveRef = useAliveRef();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [targets] = useState(() =>
    selected
      .filter((workspace) => workspace.archivingAt === null)
      .map((workspace) => ({
        key: dashWorkspaceKey(workspace),
        id: workspace.id,
        serverId: workspace.serverId,
        hostLabel: workspace.hostLabel,
        name: workspace.name,
        risks: describeArchiveRisks(workspace),
      })),
  );

  const archiveAll = useCallback(async () => {
    setBusy(true);
    const failures: string[] = [];
    let archived = 0;
    for (const target of targets) {
      const api = resolveApi(target.serverId);
      if (!api) {
        failures.push(`${target.name}: ${target.hostLabel} is disconnected`);
      } else {
        try {
          const result = await api.workspaces.archive(target.id);
          if (result.error) failures.push(`${target.name}: ${result.error}`);
          else archived += 1;
        } catch (cause) {
          failures.push(`${target.name}: ${errorMessage(cause)}`);
        }
      }
      if (aliveRef.current) setDone(archived + failures.length);
    }
    if (failures.length === 0) {
      toast.show(`Archived ${plural(archived, "workspace")}`, { variant: "success" });
    } else {
      toast.error(`Archived ${archived} of ${targets.length}. Failed: ${failures.join("; ")}`);
    }
    if (aliveRef.current) {
      setBusy(false);
      onClose();
    }
  }, [aliveRef, onClose, resolveApi, targets, toast]);

  const risky = targets.filter((target) => target.risks.length > 0);
  const hiddenRisky = Math.max(0, risky.length - PREVIEW_LIMIT);

  return (
    <Modal
      title={`Archive ${plural(targets.length, "workspace")}?`}
      icon={<Icon name="Archive" size={16} color={theme.colors.foreground} />}
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal.Content>
        <View style={styles.body}>
          <Text style={styles.intro}>
            {targets.length === 0
              ? "Every selected workspace is already being archived."
              : risky.length === 0
                ? "Archiving removes these workspaces from Paseo. None of them has uncommitted changes or unpushed commits."
                : `Archiving removes these workspaces from Paseo. ${plural(risky.length, "workspace")} still ${risky.length === 1 ? "holds" : "hold"} work that is not saved anywhere else:`}
          </Text>
          {risky.length > 0 ? (
            <ScrollView style={styles.riskList} contentContainerStyle={styles.riskListContent}>
              {risky.slice(0, PREVIEW_LIMIT).map((target) => (
                <View key={target.key} style={styles.risk}>
                  <Icon name="TriangleAlert" size={12} color={theme.colors.statusWarning} />
                  <Text style={styles.riskName} numberOfLines={1}>
                    {target.name}
                  </Text>
                  <Text style={styles.riskDetail} numberOfLines={1}>
                    {target.risks.join(", ")}
                  </Text>
                </View>
              ))}
              {hiddenRisky > 0 ? (
                <Text style={styles.more}>and {plural(hiddenRisky, "more")}</Text>
              ) : null}
            </ScrollView>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel archiving"
              disabled={busy}
              onPress={onClose}
              style={({ pressed }) => [
                styles.dialogButton,
                styles.cancel,
                pressed ? styles.pressed : null,
                busy ? styles.disabled : null,
              ]}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Archive ${plural(targets.length, "workspace")}`}
              accessibilityState={{ busy, disabled: busy || targets.length === 0 }}
              disabled={busy || targets.length === 0}
              onPress={() => void archiveAll()}
              style={({ pressed }) => [
                styles.dialogButton,
                styles.confirm,
                pressed ? styles.pressed : null,
                busy || targets.length === 0 ? styles.disabled : null,
              ]}
            >
              {busy ? (
                <View style={styles.progress}>
                  <ActivityIndicator size="small" color={theme.colors.accentForeground} />
                  <Text style={styles.confirmText}>
                    {done} / {targets.length}
                  </Text>
                </View>
              ) : (
                <Text style={styles.confirmText}>Archive {targets.length}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** One picker row: a label and how many of the selected workspaces carry it right now. */
interface LabelRow {
  option: LabelOption;
  carriers: number;
  /** True for the "create this label" row the search box offers for an unknown name. */
  created: boolean;
}

/**
 * Adds or removes one label at a time across the selection. The dialog stays open so several
 * labels can be changed in a row; the counts follow the directory stream as the daemon applies
 * each change. Workspaces that already have (or lack) the label are skipped rather than sent a
 * no-op.
 */
function LabelDialog({
  mode,
  selected,
  labelOptions,
  theme,
  scheme,
  resolveApi,
  onClose,
}: {
  mode: LabelMode;
  selected: readonly DashWorkspace[];
  labelOptions: readonly LabelOption[];
  theme: PluginTheme;
  scheme: ColorScheme;
  resolveApi(serverId: string): PaseoApi | null;
  onClose(): void;
}) {
  const toast = useToast();
  const styles = useMemo(() => createStyles(theme, false), [theme]);
  const aliveRef = useAliveRef();
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const total = selected.length;

  const supported = useMemo(
    () => selected.some((workspace) => canAssignLabels(resolveApi(workspace.serverId))),
    [resolveApi, selected],
  );

  const rows = useMemo((): LabelRow[] => {
    const carriers = (key: string) =>
      selected.reduce((count, workspace) => count + (hasLabel(workspace, key) ? 1 : 0), 0);
    let options: readonly LabelOption[] = labelOptions;
    if (mode === "remove") {
      // Only what the selection actually carries, named as it is written on the workspaces.
      const present = new Map<string, LabelOption>();
      const known = new Map(labelOptions.map((option) => [option.key, option]));
      for (const workspace of selected) {
        for (const name of workspace.labels) {
          const key = labelKey(name);
          if (!present.has(key))
            present.set(key, known.get(key) ?? { key, name, color: undefined });
        }
      }
      options = [...present.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    const needle = labelKey(query);
    const matching = options
      .filter((option) => needle === "" || option.key.includes(needle))
      .map((option) => ({ option, carriers: carriers(option.key), created: false }));
    if (mode === "add" && needle !== "" && !options.some((option) => option.key === needle)) {
      const name = query.replace(/\s+/g, " ").trim();
      matching.unshift({
        option: { key: needle, name, color: undefined },
        carriers: carriers(needle),
        created: true,
      });
    }
    return matching;
  }, [labelOptions, mode, query, selected]);

  const apply = useCallback(
    async (option: LabelOption) => {
      const assigned = mode === "add";
      const targets = selected.filter(
        (workspace) =>
          workspace.archivingAt === null && hasLabel(workspace, option.key) !== assigned,
      );
      if (targets.length === 0) return;
      setRunning(option.key);
      const failures: string[] = [];
      let changed = 0;
      for (const workspace of targets) {
        const api = resolveApi(workspace.serverId);
        if (!api) {
          failures.push(`${workspace.name}: ${workspace.hostLabel} is disconnected`);
          continue;
        }
        // Removal names the label as this workspace spells it; the host matches either way.
        const name = assigned
          ? option.name
          : (workspace.labels.find((label) => labelKey(label) === option.key) ?? option.name);
        try {
          await assignWorkspaceLabel(api, workspace.id, name, assigned);
          changed += 1;
        } catch (cause) {
          failures.push(`${workspace.name}: ${errorMessage(cause)}`);
        }
      }
      const verb = assigned ? "Added" : "Removed";
      const preposition = assigned ? "to" : "from";
      if (failures.length === 0) {
        toast.show(`${verb} "${option.name}" ${preposition} ${plural(changed, "workspace")}`, {
          variant: "success",
        });
      } else {
        toast.error(
          `${verb} "${option.name}" ${preposition} ${changed} of ${targets.length}. Failed: ${failures.join("; ")}`,
        );
      }
      if (aliveRef.current) {
        setRunning(null);
        if (assigned) setQuery("");
      }
    },
    [aliveRef, mode, resolveApi, selected, toast],
  );

  const title =
    mode === "add"
      ? `Add a label to ${plural(total, "workspace")}`
      : `Remove a label from ${plural(total, "workspace")}`;

  return (
    <Modal
      title={title}
      icon={<Icon name="Tag" size={16} color={theme.colors.foreground} />}
      open
      onOpenChange={(next) => {
        if (!next && running === null) onClose();
      }}
    >
      <Modal.Content>
        <View style={styles.body}>
          {!supported ? (
            <Text style={styles.intro}>
              Changing workspace labels from the dash needs Paseo 0.16.0 or later on both the app
              and the host.
            </Text>
          ) : (
            <>
              <View style={styles.search}>
                <Icon name="Search" size={13} color={theme.colors.foregroundMuted} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  placeholder={mode === "add" ? "Find or create a label" : "Find a label"}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel={mode === "add" ? "Find or create a label" : "Find a label"}
                  onSubmitEditing={() => {
                    const first = rows[0];
                    if (first && running === null) void apply(first.option);
                  }}
                  style={styles.searchInput}
                />
              </View>
              <ScrollView style={styles.labelList} contentContainerStyle={styles.labelListContent}>
                {rows.map((row) => (
                  <LabelPickerRow
                    key={`${row.created ? "new" : "known"}:${row.option.key}`}
                    row={row}
                    mode={mode}
                    total={total}
                    busy={running === row.option.key}
                    blocked={running !== null}
                    theme={theme}
                    scheme={scheme}
                    styles={styles}
                    onPress={() => void apply(row.option)}
                  />
                ))}
                {rows.length === 0 ? (
                  <Text style={styles.more}>
                    {mode === "add" ? "Type a name to create a label" : "No matching labels"}
                  </Text>
                ) : null}
              </ScrollView>
            </>
          )}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done"
              disabled={running !== null}
              onPress={onClose}
              style={({ pressed }) => [
                styles.dialogButton,
                styles.confirm,
                pressed ? styles.pressed : null,
                running !== null ? styles.disabled : null,
              ]}
            >
              <Text style={styles.confirmText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

function LabelPickerRow({
  row,
  mode,
  total,
  busy,
  blocked,
  theme,
  scheme,
  styles,
  onPress,
}: {
  row: LabelRow;
  mode: LabelMode;
  total: number;
  busy: boolean;
  blocked: boolean;
  theme: PluginTheme;
  scheme: ColorScheme;
  styles: BulkStyles;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const { option, carriers } = row;
  // Nothing left to do: every selected workspace already has it (add) or none has it (remove).
  const settled = mode === "add" ? carriers === total : carriers === 0;
  const disabled = settled || blocked;
  const status = row.created
    ? "New label"
    : carriers === 0
      ? "on none"
      : carriers === total
        ? total === 1
          ? "on it"
          : `on all ${total}`
        : `on ${carriers} of ${total}`;
  const action = mode === "add" ? "Add" : "Remove";
  const foreground = option.color
    ? identityForeground(option.color, scheme)
    : theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${action} ${option.name}, ${status}`}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={[styles.labelRow, hovered && !disabled ? styles.labelRowHovered : null]}
    >
      <View style={styles.labelRowIcon}>
        {busy ? (
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
        ) : settled ? (
          <Icon name="Check" size={14} color={theme.colors.foregroundMuted} />
        ) : (
          <Icon
            name={mode === "add" ? "Plus" : "Minus"}
            size={14}
            color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
          />
        )}
      </View>
      <View
        style={[
          styles.chip,
          option.color ? { backgroundColor: identityTint(option.color) } : styles.chipNeutral,
          settled ? styles.disabled : null,
        ]}
      >
        <Text style={[styles.chipText, { color: foreground }]} numberOfLines={1}>
          {option.name}
        </Text>
      </View>
      <View style={styles.spacer} />
      <Text style={styles.labelStatus} numberOfLines={1}>
        {status}
      </Text>
    </Pressable>
  );
}

type BulkStyles = ReturnType<typeof createStyles>;

function createStyles(theme: PluginTheme, compact: boolean) {
  return StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 6,
      marginHorizontal: compact ? 16 : 24,
      marginTop: 6,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.surface1,
    },
    count: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 },
    spacer: { flex: 1 },
    button: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      minHeight: 28,
      paddingVertical: 4,
      paddingHorizontal: 8,
      borderRadius: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    buttonHovered: { backgroundColor: theme.colors.surface2 },
    buttonText: { fontSize: 12, fontWeight: "600" },

    body: { gap: 14, paddingTop: 4, minWidth: 260, maxWidth: 480 },
    intro: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
    riskList: { maxHeight: 220 },
    riskListContent: { gap: 6 },
    risk: { flexDirection: "row", alignItems: "center", gap: 6 },
    riskName: { color: theme.colors.foreground, fontSize: 13, flexShrink: 1 },
    riskDetail: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
    more: { color: theme.colors.foregroundMuted, fontSize: 12, paddingVertical: 6 },

    search: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 36,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    // 16px keeps iOS from zooming the page when the field takes focus.
    searchInput: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      fontSize: 16,
      paddingVertical: 6,
    },
    labelList: { maxHeight: 300 },
    labelListContent: { gap: 2 },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 36,
      paddingVertical: 6,
      paddingHorizontal: 6,
      borderRadius: 8,
    },
    labelRowHovered: { backgroundColor: theme.colors.surface2 },
    labelRowIcon: { width: 18, alignItems: "center" },
    labelStatus: { color: theme.colors.foregroundMuted, fontSize: 12 },
    chip: {
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 1,
      maxWidth: 240,
      flexShrink: 1,
    },
    chipNeutral: {
      backgroundColor: theme.colors.surface1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
    },
    chipText: { fontSize: 13, lineHeight: 18 },

    actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" },
    dialogButton: {
      minHeight: 34,
      minWidth: 92,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 9,
      alignItems: "center",
      justifyContent: "center",
    },
    cancel: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    cancelText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
    confirm: { backgroundColor: theme.colors.accent },
    confirmText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "700" },
    progress: { flexDirection: "row", alignItems: "center", gap: 8 },
    pressed: { opacity: 0.85 },
    disabled: { opacity: 0.5 },
  });
}
