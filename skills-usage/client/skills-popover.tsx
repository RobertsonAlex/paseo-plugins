import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { copyText, Icon, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { buildSkillGroups, skillMention, type SkillRow, type SkillScope } from "../shared/skills";
import { useAvailableSkills, useSkillScopes, useSkillUses } from "./use-skills";
import { focusComposer, insertComposerText } from "./web";

const FOCUS_DELAY_MS = 60;

const SCOPE_PRESENTATION: Record<SkillScope, { icon: string; label: string }> = {
  user: { icon: "User", label: "User" },
  project: { icon: "FolderGit2", label: "Project" },
  "project-local": { icon: "FolderLock", label: "Project (local)" },
  plugin: { icon: "Puzzle", label: "Plugin" },
  builtin: { icon: "Cpu", label: "Built-in" },
};
const LEGEND_ORDER: SkillScope[] = ["user", "project", "project-local", "plugin", "builtin"];

function scopeIcon(scope: SkillScope | null): string {
  return scope ? SCOPE_PRESENTATION[scope].icon : "Sparkles";
}

function scopeLabel(scope: SkillScope | null): string {
  return scope ? SCOPE_PRESENTATION[scope].label : "Skill";
}

export function SkillsPopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") {
    return (
      <Text style={[styles.note, { color: props.theme.colors.foregroundMuted }]}>
        Skills are listed per agent.
      </Text>
    );
  }
  return <AgentSkillsPopover {...props} />;
}

function AgentSkillsPopover({
  host,
  agentId,
  theme,
  layout,
  close,
}: Extract<PluginButtonContentProps, { context: "agent" }>) {
  const colors = theme.colors;
  const toast = useToast();
  const [query, setQuery] = useState("");
  const available = useAvailableSkills(host.id, agentId);
  const uses = useSkillUses(host.id, agentId);
  const scopes = useSkillScopes(host.id, agentId);

  const groups = useMemo(
    () =>
      buildSkillGroups({
        available: available.data?.skills ?? [],
        uses: uses.data ?? [],
        query,
        scopes: scopes.data?.found ?? null,
      }),
    [available.data, uses.data, query, scopes.data],
  );
  const presentScopes = useMemo(() => {
    const seen = new Set<SkillScope>();
    for (const row of [...groups.used, ...groups.all]) if (row.scope) seen.add(row.scope);
    return LEGEND_ORDER.filter((scope) => seen.has(scope));
  }, [groups]);

  async function pick(row: SkillRow) {
    const text = skillMention(row.name);
    if (insertComposerText(agentId, text)) {
      close();
      setTimeout(() => focusComposer(agentId), FOCUS_DELAY_MS);
      return;
    }
    try {
      await copyText(text);
      toast.show(`Copied ${text}. Paste it into the message.`, { variant: "info" });
    } catch {
      toast.error(`Could not insert ${text}. Type it into the message.`);
    }
    close();
  }

  const loading = available.isPending || uses.isPending;
  const providerError = available.data?.error ?? scopes.data?.error ?? null;
  const loadError = available.error ?? uses.error;
  const empty = !loading && groups.used.length === 0 && groups.all.length === 0;

  return (
    <View style={styles.body}>
      <TextInput
        accessibilityLabel="Search skills"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setQuery}
        placeholder="Search skills"
        placeholderTextColor={colors.foregroundMuted}
        returnKeyType="search"
        selectionColor={colors.accent}
        style={[
          styles.search,
          {
            color: colors.foreground,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
            fontSize: layout.compact ? 16 : 14,
          },
        ]}
        value={query}
      />
      {loadError ? (
        <Text style={[styles.note, { color: colors.statusDanger }]}>
          {loadError instanceof Error ? loadError.message : String(loadError)}
        </Text>
      ) : null}
      {providerError ? (
        <Text style={[styles.note, { color: colors.statusWarning }]}>{providerError}</Text>
      ) : null}
      {loading ? (
        <Text style={[styles.note, { color: colors.foregroundMuted }]}>Loading skills…</Text>
      ) : null}
      {empty ? (
        <Text style={[styles.note, { color: colors.foregroundMuted }]}>
          {query.trim() ? "No skills match." : "No skills are available to this agent."}
        </Text>
      ) : null}
      {groups.used.length > 0 ? (
        <SkillGroup
          title="Used in this chat"
          rows={groups.used}
          badge={false}
          colors={colors}
          compact={layout.compact}
          onPick={pick}
        />
      ) : null}
      {groups.all.length > 0 ? (
        <SkillGroup
          title="All skills"
          rows={groups.all}
          badge
          colors={colors}
          compact={layout.compact}
          onPick={pick}
        />
      ) : null}
      {presentScopes.length > 0 ? (
        <View accessibilityLabel="Skill location legend" style={[styles.legend, { borderTopColor: colors.border }]}>
          {presentScopes.map((scope) => (
            <View key={scope} style={styles.legendItem}>
              <Icon name={SCOPE_PRESENTATION[scope].icon} size={12} color={colors.foregroundMuted} />
              <Text style={[styles.legendText, { color: colors.foregroundMuted }]}>
                {SCOPE_PRESENTATION[scope].label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SkillGroup({
  title,
  rows,
  badge,
  colors,
  compact,
  onPick,
}: {
  title: string;
  rows: SkillRow[];
  badge: boolean;
  colors: PluginButtonContentProps["theme"]["colors"];
  compact: boolean;
  onPick: (row: SkillRow) => void;
}) {
  return (
    <View style={styles.group}>
      <Text style={[styles.groupTitle, { color: colors.foregroundMuted }]}>
        {title.toUpperCase()} · {rows.length}
      </Text>
      {rows.map((row) => (
        <Pressable
          key={row.name}
          accessibilityRole="button"
          accessibilityLabel={`Mention skill ${row.name} (${scopeLabel(row.scope).toLowerCase()} skill)`}
          onPress={() => onPick(row)}
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: pressed ? colors.surface2 : "transparent", paddingVertical: compact ? 10 : 6 },
          ]}
        >
          <View style={styles.rowHeader}>
            <Icon
              name={scopeIcon(row.scope)}
              size={14}
              color={row.used ? colors.accent : colors.foregroundMuted}
            />
            <Text numberOfLines={1} style={[styles.name, { color: colors.foreground }]}>
              {row.name}
            </Text>
            {badge && row.used ? (
              <View style={[styles.badge, { backgroundColor: colors.accent }]}>
                <Text style={[styles.badgeText, { color: colors.accentForeground }]}>
                  {row.useCount > 1 ? `Used ×${row.useCount}` : "Used"}
                </Text>
              </View>
            ) : null}
            {!badge && row.useCount > 1 ? (
              <Text style={[styles.count, { color: colors.foregroundMuted }]}>×{row.useCount}</Text>
            ) : null}
          </View>
          {row.description ? (
            <Text numberOfLines={2} style={[styles.description, { color: colors.foregroundMuted }]}>
              {row.description}
            </Text>
          ) : !row.available ? (
            <Text numberOfLines={1} style={[styles.description, { color: colors.foregroundMuted }]}>
              Loaded in this chat; not in the current skill list.
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: 10,
    minWidth: 260,
  },
  search: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
  },
  group: {
    gap: 2,
  },
  groupTitle: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  row: {
    borderRadius: 8,
    gap: 2,
    marginHorizontal: -6,
    paddingHorizontal: 6,
  },
  rowHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  name: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: "600",
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  count: {
    fontSize: 12,
  },
  description: {
    fontSize: 12,
    lineHeight: 16,
    paddingLeft: 20,
  },
  legend: {
    borderTopWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingTop: 8,
  },
  legendItem: {
    alignItems: "center",
    flexDirection: "row",
    gap: 4,
  },
  legendText: {
    fontSize: 11,
  },
});
