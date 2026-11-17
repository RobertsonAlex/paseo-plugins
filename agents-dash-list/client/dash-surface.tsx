import type { PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, usePaseo } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  type StyleProp,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import type {
  DecorationProjectInput,
  LabelDefinition,
  WorkspaceLabelColor,
} from "../shared/contracts";
import { groupColor, identityFill, themeScheme } from "../shared/colors";
import {
  DASH_GROUP_DESCRIPTIONS,
  DASH_GROUP_ICONS,
  DASH_GROUP_LABELS,
  type DashGroup,
  type DashHostSource,
  type DashModel,
  type DashWorkspace,
  buildDashModel,
  dashWorkspaceKey,
  filterDashModel,
  hasLabel,
  labelKey,
  matchesSearch,
  quickActionsFor,
  searchTerms,
} from "../shared/model";
import { BulkActionBar, type LabelOption } from "./bulk-actions";
import { type CheckState, Checkbox } from "./checkbox";
import { Dropdown, type DropdownOption } from "./dropdown";
import { useDashHosts, resolveHostApi } from "./hosts";
import { type HostDirectory, useDashDirectories } from "./use-directory";
import { useDecorations } from "./use-decorations";
import { useDashSettings } from "./use-settings";
import { useUnreadMarks } from "./use-unread";
import { WorkspaceRow, buildLabelColors } from "./workspace-row";

/**
 * The sidebar surface: every workspace of every configured host, grouped by what it needs from
 * the user. Each host's workspace and agent directories stream in over its own SDK connection and
 * are merged into one feed by `buildDashModel`; every row carries the host it came from, opens
 * there, and is archived through that host's API.
 *
 * Project icons and the label catalog come from the plugin's server entry, which only runs on the
 * host the dash was opened on: plugin RPC has no cross-host form. Icons are therefore requested
 * for that host's projects alone and other hosts' rows fall back to the project initial, while
 * the label catalog — a small list of names and colors — is applied to every host.
 *
 * The host, project and label filters and the folded groups are viewing preferences the server
 * entry stores per daemon, so the dash opens the way it was left, app restarts included. The
 * search box and the row selection are transient and live in this component only.
 *
 * Selection is keyed by `dashWorkspaceKey` and only ever acts on rows that are on screen: a row a
 * filter or search hides stays remembered but is left out of the count and every bulk action, so
 * nothing invisible gets archived or relabelled.
 */

/** How often the relative timestamps are recomputed. */
const CLOCK_INTERVAL_MS = 30_000;
/** The decorations contract accepts at most this many projects per call. */
const MAX_DECORATED_PROJECTS = 500;
/** The unread contract accepts at most this many workspace ids per call. */
const MAX_PRUNE_WORKSPACE_IDS = 2000;
const NO_WORKSPACE_IDS: readonly string[] = [];
const NO_WORKSPACES: readonly DashWorkspace[] = [];

export function DashSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const own = useMemo(() => ({ id: host.id, api: paseo }), [host.id, paseo]);
  const hosts = useDashHosts(host);
  const directories = useDashDirectories(hosts, own);
  const resolveApi = useCallback(
    (serverId: string): PaseoApi | null => resolveHostApi(serverId, own),
    [own],
  );
  const scheme = useMemo(() => themeScheme(theme), [theme]);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // Every host's ids, filters ignored: the server prunes the marks it is not shown, and a mark
  // belongs to a workspace whether or not the user is currently looking at its host.
  const allWorkspaceIds = useMemo(
    () => directories.hosts.flatMap((entry) => [...entry.workspaces.keys()]),
    // The maps are mutated in place; `version` is what says they changed.
    [directories.hosts, directories.version],
  );
  const censusComplete = directories.hosts.every(
    (entry) => entry.status === "ready" && entry.complete,
  );

  const settings = useDashSettings(host.id);
  const selectedHosts = settings.hostIds;
  const visibleHosts = useMemo(
    () =>
      selectedHosts.size === 0
        ? directories.hosts
        : directories.hosts.filter((entry) => selectedHosts.has(entry.serverId)),
    [directories.hosts, selectedHosts],
  );
  const hostOptions = useMemo(
    () =>
      directories.hosts.map((entry) => ({
        id: entry.serverId,
        label: entry.status === "offline" ? `${entry.label} (offline)` : entry.label,
        icon: "Server",
        count: entry.workspaces.size,
      })),
    [directories.hosts, directories.version],
  );
  const hostSummary = summarizeChoice(
    selectedHosts,
    new Map(directories.hosts.map((entry) => [entry.serverId, entry.label])),
  );

  const visibleWorkspaceCount = useMemo(
    () => visibleHosts.reduce((count, entry) => count + entry.workspaces.size, 0),
    [visibleHosts, directories.version],
  );

  // Icons are read from disk by the server entry, which only runs on the host the dash was
  // opened on; another host's project paths mean nothing there.
  const ownProjects = useMemo(() => {
    const own = directories.hosts.find((entry) => entry.serverId === host.id);
    return own ? collectProjects(own.workspaces.values()) : [];
  }, [directories.hosts, directories.version, host.id]);

  const projectOptions = useMemo(
    () => buildProjectOptions(visibleHosts),
    [visibleHosts, directories.version],
  );
  const projectNames = useMemo(
    () => new Map(projectOptions.map((option) => [option.id, option.label])),
    [projectOptions],
  );
  const projectSummary = summarizeChoice(settings.projectIds, projectNames);

  const decorations = useDecorations(host.id, ownProjects);
  const labelColors = useMemo(() => buildLabelColors(decorations.labels), [decorations.labels]);
  // Pruning on the server keys off this list, so it is only handed over once every page of every
  // host's directory has landed and the whole census still fits the contract; a partial list
  // would permanently delete the marks of the workspaces it omits.
  const pruneIds =
    censusComplete && allWorkspaceIds.length <= MAX_PRUNE_WORKSPACE_IDS
      ? allWorkspaceIds
      : NO_WORKSPACE_IDS;
  const { marks, setUnread } = useUnreadMarks(host.id, pruneIds);

  const selectedProjects = settings.projectIds;
  const sources = useMemo(
    (): DashHostSource[] =>
      visibleHosts.map((entry) => ({
        serverId: entry.serverId,
        hostLabel: entry.label,
        workspaces: filterByProject(entry.workspaces.values(), selectedProjects),
        agents: entry.agents.values(),
      })),
    [visibleHosts, directories.version, selectedProjects],
  );
  const baseModel = useMemo(
    () => buildDashModel({ hosts: sources, unreadMarks: marks }),
    [sources, marks],
  );

  // Labels are filtered after the model is built: the model is where every host's label lists
  // already sit side by side on the rows.
  const selectedLabels = settings.labelKeys;
  const labelOptions = useMemo(
    () => buildLabelOptions(baseModel, decorations.labels),
    [baseModel, decorations.labels],
  );
  const labelFilterOptions = useMemo(
    () => buildLabelFilterOptions(baseModel, labelColors, selectedLabels),
    [baseModel, labelColors, selectedLabels],
  );
  const labelSummary = summarizeChoice(
    selectedLabels,
    new Map(labelOptions.map((option) => [option.key, option.name])),
  );

  const [search, setSearch] = useState("");
  const terms = useMemo(() => searchTerms(search), [search]);
  const model = useMemo(() => {
    if (selectedLabels.size === 0 && terms.length === 0) return baseModel;
    return filterDashModel(
      baseModel,
      (workspace) =>
        (selectedLabels.size === 0 ||
          [...selectedLabels].some((key) => hasLabel(workspace, key))) &&
        matchesSearch(workspace, terms),
    );
  }, [baseModel, selectedLabels, terms]);

  const narrowed =
    selectedProjects.size > 0 ||
    selectedHosts.size > 0 ||
    selectedLabels.size > 0 ||
    terms.length > 0;
  const collapsed = settings.collapsedGroups;
  const toggleGroup = settings.toggleGroup;

  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSelected = useCallback((key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const setGroupSelected = useCallback((keys: readonly string[], select: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (select) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);
  const selectedWorkspaces = useMemo(() => {
    if (selectedKeys.size === 0) return NO_WORKSPACES;
    const kept: DashWorkspace[] = [];
    for (const entry of model.groups) {
      for (const workspace of entry.workspaces) {
        if (selectedKeys.has(dashWorkspaceKey(workspace))) kept.push(workspace);
      }
    }
    return kept;
  }, [model, selectedKeys]);
  // Archived workspaces leave the directory and their keys are dropped. Keys are checked against
  // every host's whole directory, not what the filters show, so a filter change does not
  // silently forget a selection.
  const presentKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of directories.hosts) {
      for (const id of entry.workspaces.keys()) keys.add(`${entry.serverId}/${id}`);
    }
    return keys;
    // The maps are mutated in place; `version` is what says they changed.
  }, [directories.hosts, directories.version]);
  useEffect(() => {
    setSelectedKeys((current) => {
      if ([...current].every((key) => presentKeys.has(key))) return current;
      return new Set([...current].filter((key) => presentKeys.has(key)));
    });
  }, [presentKeys]);

  // Settings decide what is shown and what is folded; drawing before they answer would flash
  // the unfiltered, unfolded dash and then rearrange it.
  const loading =
    (visibleHosts.some((entry) => entry.status === "loading") && baseModel.total === 0) ||
    !settings.ready;
  const troubled = visibleHosts.filter(
    (entry) => entry.status === "error" || entry.status === "offline",
  );
  // Only a total loss takes over the screen: with one host answering, the others are a notice
  // above the feed so the workspaces that did arrive stay usable.
  const failed = visibleHosts.length > 0 && troubled.length === visibleHosts.length;

  return (
    <View style={styles.screen}>
      {/* The screen header above already carries the icon and the "Agents dash" title, so these
          rows only hold what it does not: the search box, the count, the host, project and
          label filters and the refresh affordance. */}
      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Icon name="Search" size={13} color={theme.colors.foregroundMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search workspaces, branches, agents, labels"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search the dash"
            returnKeyType="search"
            style={styles.searchInput}
          />
          {search ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear the search"
              hitSlop={8}
              onPress={() => setSearch("")}
              style={styles.searchClear}
            >
              <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={styles.header}>
        <Text style={styles.total} numberOfLines={1}>
          {narrowed ? `${model.total} of ${allWorkspaceIds.length}` : model.total}{" "}
          {(narrowed ? allWorkspaceIds.length : model.total) === 1 ? "workspace" : "workspaces"}
        </Text>
        <View style={styles.headerSpacer} />
        {/* A single configured host needs no filter: the rows still name it. */}
        {directories.hosts.length > 1 ? (
          <Dropdown
            label="Host"
            icon="Server"
            summary={hostSummary}
            options={hostOptions}
            selected={selectedHosts}
            multi
            onToggle={settings.toggleHost}
            onClear={() => settings.setHostIds([])}
            theme={theme}
            compact={layout.compact}
          />
        ) : null}
        <Dropdown
          label="Project"
          icon="FolderGit2"
          summary={projectSummary}
          options={projectOptions}
          selected={selectedProjects}
          multi
          onToggle={settings.toggleProject}
          onClear={() => settings.setProjectIds([])}
          theme={theme}
          compact={layout.compact}
        />
        <Dropdown
          label="Label"
          icon="Tag"
          summary={labelSummary}
          options={labelFilterOptions}
          selected={selectedLabels}
          multi
          onToggle={settings.toggleLabel}
          onClear={() => settings.setLabelKeys([])}
          theme={theme}
          compact={layout.compact}
        />
        <RefreshButton
          theme={theme}
          style={styles.refresh}
          busy={loading}
          onPress={directories.refresh}
        />
      </View>

      <BulkActionBar
        selected={selectedWorkspaces}
        labelOptions={labelOptions}
        theme={theme}
        scheme={scheme}
        compact={layout.compact}
        resolveApi={resolveApi}
        onClear={clearSelection}
      />

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : failed ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{describeTrouble(troubled)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading the dash"
            onPress={directories.refresh}
            style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : model.groups.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.empty}>
            {describeEmpty(
              visibleHosts,
              selectedProjects,
              selectedLabels.size > 0 || terms.length > 0,
            )}
          </Text>
          {narrowed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear the filters and the search"
              onPress={() => {
                settings.clearFilters();
                setSearch("");
              }}
              style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
            >
              <Text style={styles.retryText}>Clear filters</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          {troubled.length > 0 ? (
            <View style={styles.notice}>
              <Icon name="TriangleAlert" size={13} color={theme.colors.statusWarning} />
              <Text style={styles.noticeText}>{describeTrouble(troubled)}</Text>
            </View>
          ) : null}
          {model.groups.map(({ group, workspaces }) => (
            <GroupSection
              key={group}
              group={group}
              workspaces={workspaces}
              selectedKeys={selectedKeys}
              onSelectGroup={setGroupSelected}
              expanded={!collapsed.has(group)}
              onToggle={toggleGroup}
              theme={theme}
              scheme={scheme}
              styles={styles}
            >
              {workspaces.map((workspace) => {
                const key = dashWorkspaceKey(workspace);
                return (
                  <WorkspaceRow
                    key={key}
                    selectionKey={key}
                    selected={selectedKeys.has(key)}
                    onToggleSelected={toggleSelected}
                    workspace={workspace}
                    actions={quickActionsFor(group)}
                    theme={theme}
                    scheme={scheme}
                    nowMs={nowMs}
                    iconUri={
                      workspace.serverId === host.id
                        ? (decorations.icons[workspace.projectId] ?? null)
                        : null
                    }
                    labelColors={labelColors}
                    navigation={navigation}
                    paseo={resolveApi(workspace.serverId)}
                    setUnread={setUnread}
                  />
                );
              })}
            </GroupSection>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/** The one sentence that names what is wrong, however many hosts are in trouble. */
function describeTrouble(troubled: readonly HostDirectory[]): string {
  if (troubled.length === 0) return "";
  const [first] = troubled;
  if (troubled.length === 1 && first) {
    if (first.status === "offline") return `${first.label} is disconnected.`;
    return first.error ?? `Could not load the workspace directory on ${first.label}.`;
  }
  return `${troubled.length} hosts could not be read: ${troubled
    .map((entry) => entry.label)
    .join(", ")}.`;
}

/** What an empty feed means depends on whether a filter, or the hosts themselves, emptied it. */
function describeEmpty(
  visibleHosts: readonly HostDirectory[],
  selectedProjects: ReadonlySet<string>,
  searchedOrLabelled: boolean,
): string {
  const [only] = visibleHosts;
  if (!only) return "No hosts selected";
  const where = visibleHosts.length === 1 ? `on ${only.label}` : `on ${visibleHosts.length} hosts`;
  if (searchedOrLabelled) return `No workspaces match ${where}`;
  if (selectedProjects.size === 0) return `No workspaces ${where}`;
  return `No workspaces in the selected ${selectedProjects.size === 1 ? "project" : "projects"} ${where}`;
}

/**
 * One status group: a bordered card whose header names the status and folds the rows away.
 * The header is the whole touch target, so collapsing works with a thumb as well as a pointer;
 * the selection box at its left end, outside that target, ticks or clears every row in it.
 */
function GroupSection({
  group,
  workspaces,
  selectedKeys,
  onSelectGroup,
  expanded,
  onToggle,
  theme,
  scheme,
  styles,
  children,
}: {
  group: DashGroup;
  workspaces: readonly DashWorkspace[];
  selectedKeys: ReadonlySet<string>;
  onSelectGroup(keys: readonly string[], select: boolean): void;
  expanded: boolean;
  onToggle(group: DashGroup): void;
  theme: PluginTheme;
  scheme: ReturnType<typeof themeScheme>;
  styles: SurfaceStyles;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const label = DASH_GROUP_LABELS[group];
  const count = workspaces.length;
  const keys = useMemo(() => workspaces.map(dashWorkspaceKey), [workspaces]);
  const ticked = keys.reduce((total, key) => total + (selectedKeys.has(key) ? 1 : 0), 0);
  const checkState: CheckState =
    ticked === 0 ? "unchecked" : ticked === keys.length ? "checked" : "mixed";
  return (
    <View style={styles.group}>
      <View
        style={[
          styles.groupHeader,
          hovered ? styles.groupHeaderHovered : null,
          expanded ? styles.groupHeaderExpanded : null,
        ]}
      >
        <Checkbox
          state={checkState}
          label={
            checkState === "checked"
              ? `Deselect every workspace in ${label}`
              : `Select every workspace in ${label}`
          }
          theme={theme}
          onToggle={() => onSelectGroup(keys, checkState !== "checked")}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${count} ${count === 1 ? "workspace" : "workspaces"}`}
          accessibilityHint={DASH_GROUP_DESCRIPTIONS[group]}
          accessibilityState={{ expanded }}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          onPress={() => onToggle(group)}
          style={styles.groupToggle}
        >
          <Icon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            size={14}
            color={theme.colors.foregroundMuted}
          />
          <Icon name={DASH_GROUP_ICONS[group]} size={15} color={groupColor(group, theme, scheme)} />
          <Text style={styles.groupLabel} numberOfLines={1}>
            {label}
          </Text>
          <View style={styles.groupCountBadge}>
            <Text style={styles.groupCount}>{count}</Text>
          </View>
        </Pressable>
      </View>
      {expanded ? <View style={styles.rows}>{children}</View> : null}
    </View>
  );
}

function RefreshButton({
  theme,
  style,
  busy,
  onPress,
}: {
  theme: PluginTheme;
  style: StyleProp<ViewStyle>;
  busy: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh the dash"
      accessibilityState={{ busy }}
      hitSlop={6}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={style}
    >
      <Icon
        name="RefreshCw"
        size={14}
        color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
    </Pressable>
  );
}

/** Only the workspaces of the chosen projects; an empty choice keeps every workspace. */
function filterByProject(
  workspaces: Iterable<PaseoWorkspace>,
  projectIds: ReadonlySet<string>,
): Iterable<PaseoWorkspace> {
  if (projectIds.size === 0) return workspaces;
  const kept: PaseoWorkspace[] = [];
  for (const workspace of workspaces) {
    if (projectIds.has(workspace.projectId)) kept.push(workspace);
  }
  return kept;
}

/**
 * One picker row per project with its workspace count, alphabetically, across every visible host.
 * Two projects can share a display name (a checkout and a plain directory, or the same repository
 * checked out on two hosts); the root path tells them apart.
 */
function buildProjectOptions(hosts: readonly HostDirectory[]): DropdownOption[] {
  const counts = new Map<string, { name: string; rootPath: string; count: number }>();
  for (const host of hosts) {
    for (const workspace of host.workspaces.values()) {
      const entry = counts.get(workspace.projectId);
      if (entry) entry.count += 1;
      else {
        counts.set(workspace.projectId, {
          name: workspace.projectDisplayName,
          rootPath: workspace.projectRootPath,
          count: 1,
        });
      }
    }
  }
  const nameCounts = new Map<string, number>();
  for (const entry of counts.values()) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, entry]) => ({
      id,
      label:
        (nameCounts.get(entry.name) ?? 0) > 1 ? `${entry.name} (${entry.rootPath})` : entry.name,
      icon: "FolderGit2",
      count: entry.count,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Text on a filter trigger: the name for one choice, a count for more. A stored id whose project
 * or host has since gone still counts as a choice, so the trigger never claims "All" while rows
 * are being hidden.
 */
function summarizeChoice(
  selected: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
): string | null {
  if (selected.size === 0) return null;
  if (selected.size === 1) {
    const [id] = selected;
    return names.get(id ?? "") ?? "1 selected";
  }
  return `${selected.size} selected`;
}

/**
 * Every label the add picker can offer: the opening host's catalog (with its colors) and every
 * label already on a row, whichever host it came from, one entry per key, alphabetically.
 */
function buildLabelOptions(model: DashModel, catalog: readonly LabelDefinition[]): LabelOption[] {
  const options = new Map<string, LabelOption>();
  for (const definition of catalog) {
    const key = labelKey(definition.name);
    if (key && !options.has(key)) {
      options.set(key, {
        key,
        name: definition.name.replace(/\s+/g, " ").trim(),
        color: definition.color,
      });
    }
  }
  for (const entry of model.groups) {
    for (const workspace of entry.workspaces) {
      for (const name of workspace.labels) {
        const key = labelKey(name);
        if (key && !options.has(key)) options.set(key, { key, name, color: undefined });
      }
    }
  }
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One filter row per label found on the rows the host and project filters leave, with how many
 * workspaces carry it. A chosen label that no row carries any more is still listed, at zero, so
 * it can be unticked.
 */
function buildLabelFilterOptions(
  model: DashModel,
  colors: ReadonlyMap<string, WorkspaceLabelColor>,
  selected: ReadonlySet<string>,
): DropdownOption[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const entry of model.groups) {
    for (const workspace of entry.workspaces) {
      // A workspace counts once per label even if it spells the label twice.
      const seen = new Set<string>();
      for (const name of workspace.labels) {
        const key = labelKey(name);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const current = counts.get(key);
        if (current) current.count += 1;
        else counts.set(key, { name, count: 1 });
      }
    }
  }
  for (const key of selected) {
    if (!counts.has(key)) counts.set(key, { name: key, count: 0 });
  }
  return [...counts.entries()]
    .map(([key, entry]) => {
      const color = colors.get(key);
      return {
        id: key,
        label: entry.name,
        icon: "Tag",
        iconColor: color ? identityFill(color) : undefined,
        count: entry.count,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** One decoration request per project, in first-seen order and within the contract's ceiling. */
function collectProjects(workspaces: Iterable<PaseoWorkspace>): DecorationProjectInput[] {
  const projects = new Map<string, DecorationProjectInput>();
  for (const workspace of workspaces) {
    if (!workspace.projectId || !workspace.projectRootPath) continue;
    if (projects.has(workspace.projectId)) continue;
    if (projects.size >= MAX_DECORATED_PROJECTS) break;
    projects.set(workspace.projectId, {
      projectId: workspace.projectId,
      rootPath: workspace.projectRootPath,
      customIconRevision: workspace.projectCustomIconRevision ?? null,
    });
  }
  return [...projects.values()];
}

type SurfaceStyles = ReturnType<typeof createStyles>;

function createStyles(theme: PluginTheme, compact: boolean) {
  const gutter = compact ? 16 : 24;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 8,
      paddingHorizontal: gutter,
      paddingTop: 8,
      paddingBottom: 4,
    },
    total: { color: theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1 },
    searchRow: { paddingHorizontal: gutter, paddingTop: compact ? 8 : 12 },
    search: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 34,
      paddingLeft: 10,
      paddingRight: 6,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    // 16px keeps iOS from zooming the page when the field takes focus; desktop reads it at 13.
    searchInput: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      fontSize: compact ? 16 : 13,
      paddingVertical: 6,
    },
    searchClear: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
    headerSpacer: { flex: 1 },
    refresh: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },

    scroll: { flex: 1 },
    content: { paddingHorizontal: gutter, paddingVertical: 12, gap: compact ? 12 : 16 },
    notice: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    noticeText: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
    group: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 12,
      overflow: "hidden",
      backgroundColor: theme.colors.surface0,
    },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 6,
      paddingLeft: 12,
      paddingRight: 8,
      backgroundColor: theme.colors.surface1,
    },
    groupToggle: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 4,
    },
    groupHeaderHovered: { backgroundColor: theme.colors.surface2 },
    groupHeaderExpanded: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    groupLabel: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: "700",
      letterSpacing: 0.2,
      flexShrink: 1,
    },
    groupCountBadge: {
      minWidth: 22,
      height: 20,
      paddingHorizontal: 6,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      alignItems: "center",
      justifyContent: "center",
    },
    groupCount: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" },
    rows: { paddingVertical: 6, paddingHorizontal: 6, gap: 2 },

    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      padding: gutter,
    },
    empty: { color: theme.colors.foregroundMuted, fontSize: 14, textAlign: "center" },
    error: { color: theme.colors.statusDanger, fontSize: 14, textAlign: "center" },
    retry: {
      minHeight: 34,
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 9,
      backgroundColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    retryPressed: { opacity: 0.85 },
    retryText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "700" },
  });
}
