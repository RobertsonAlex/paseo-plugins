import type { PaseoApi } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { DASH_GROUP_LABELS, type DashGroup, type DashWorkspace } from "../shared/model";
import { describeArchiveRisks } from "./archive-confirm";

/**
 * "Archive all" for a whole group: a header button that always asks first, since one press
 * removes several workspaces at once. The dialog names how many go and lists the ones whose
 * worktree still holds unsaved work. A group can span hosts, so each workspace is archived
 * through its own host's API, one at a time so no daemon is flooded, and the outcome goes to the
 * toast host, which outlives the group when its last row leaves.
 */

const PREVIEW_LIMIT = 8;

export interface ArchiveGroupButtonProps {
  group: DashGroup;
  workspaces: readonly DashWorkspace[];
  theme: PluginTheme;
  /** Answers null for a host that is no longer connected; its workspaces are reported as failed. */
  resolveApi(serverId: string): PaseoApi | null;
}

interface Target {
  id: string;
  serverId: string;
  hostLabel: string;
  name: string;
  risks: readonly string[];
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text && text !== "undefined" ? text : "Something went wrong.";
}

/** Web bubbles presses to the group header underneath; native ignores the call. */
function stopPropagation(event?: GestureResponderEvent): void {
  event?.stopPropagation?.();
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function ArchiveGroupButton({
  group,
  workspaces,
  theme,
  resolveApi,
}: ArchiveGroupButtonProps) {
  const toast = useToast();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  // Snapshot taken when the dialog opens: rows keep moving between groups while the question is
  // on screen, and the dialog must archive exactly what the user was shown.
  const [targets, setTargets] = useState<readonly Target[]>([]);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const label = DASH_GROUP_LABELS[group];
  const candidates = workspaces.filter((workspace) => workspace.archivingAt === null).length;

  const openDialog = useCallback(() => {
    setTargets(
      workspaces
        .filter((workspace) => workspace.archivingAt === null)
        .map((workspace) => ({
          id: workspace.id,
          serverId: workspace.serverId,
          hostLabel: workspace.hostLabel,
          name: workspace.name,
          risks: describeArchiveRisks(workspace),
        })),
    );
    setDone(0);
    setOpen(true);
  }, [workspaces]);

  const archiveAll = useCallback(async () => {
    setBusy(true);
    const failures: string[] = [];
    let archived = 0;
    for (const target of targets) {
      const api = resolveApi(target.serverId);
      if (!api) {
        failures.push(`${target.name}: ${target.hostLabel} is disconnected`);
        if (aliveRef.current) setDone(archived + failures.length);
        continue;
      }
      try {
        const result = await api.workspaces.archive(target.id);
        if (result.error) failures.push(`${target.name}: ${result.error}`);
        else archived += 1;
      } catch (cause) {
        failures.push(`${target.name}: ${errorMessage(cause)}`);
      }
      if (aliveRef.current) setDone(archived + failures.length);
    }
    if (failures.length === 0) {
      toast.show(`Archived ${plural(archived, "workspace")} from ${label}`, { variant: "success" });
    } else {
      toast.error(
        `Archived ${archived} of ${targets.length} from ${label}. Failed: ${failures.join("; ")}`,
      );
    }
    if (aliveRef.current) {
      setBusy(false);
      setOpen(false);
    }
  }, [label, resolveApi, targets, toast]);

  const risky = targets.filter((target) => target.risks.length > 0);
  const hiddenRisky = Math.max(0, risky.length - PREVIEW_LIMIT);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Archive all ${plural(candidates, "workspace")} in ${label}`}
        accessibilityState={{ disabled: candidates === 0 }}
        disabled={candidates === 0}
        hitSlop={6}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={(event) => {
          stopPropagation(event);
          openDialog();
        }}
        style={[styles.button, hovered ? styles.buttonHovered : null]}
      >
        <Icon
          name="Archive"
          size={13}
          color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
        <Text style={[styles.buttonText, hovered ? styles.buttonTextHovered : null]}>
          Archive all
        </Text>
      </Pressable>

      <Modal
        title={`Archive ${plural(targets.length, "workspace")} in ${label}?`}
        icon={<Icon name="Archive" size={16} color={theme.colors.foreground} />}
        open={open}
        onOpenChange={(next) => {
          if (!next && !busy) setOpen(false);
        }}
      >
        <Modal.Content>
          <View style={styles.body}>
            <Text style={styles.intro}>
              {risky.length === 0
                ? "Archiving removes these workspaces from Paseo. None of them has uncommitted changes or unpushed commits."
                : `Archiving removes these workspaces from Paseo. ${plural(risky.length, "workspace")} still ${risky.length === 1 ? "holds" : "hold"} work that is not saved anywhere else:`}
            </Text>
            {risky.length > 0 ? (
              <ScrollView style={styles.riskList} contentContainerStyle={styles.riskListContent}>
                {risky.slice(0, PREVIEW_LIMIT).map((target) => (
                  <View key={`${target.serverId}/${target.id}`} style={styles.risk}>
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
                onPress={() => setOpen(false)}
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
                  busy ? styles.disabled : null,
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
    </>
  );
}

function createStyles(theme: PluginTheme) {
  return StyleSheet.create({
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
    buttonText: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" },
    buttonTextHovered: { color: theme.colors.foreground },

    body: { gap: 14, paddingTop: 4, minWidth: 260, maxWidth: 480 },
    intro: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
    riskList: { maxHeight: 220 },
    riskListContent: { gap: 6 },
    risk: { flexDirection: "row", alignItems: "center", gap: 6 },
    riskName: { color: theme.colors.foreground, fontSize: 13, flexShrink: 1 },
    riskDetail: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
    more: { color: theme.colors.foregroundMuted, fontSize: 12, paddingLeft: 18 },
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
    disabled: { opacity: 0.6 },
  });
}
