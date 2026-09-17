import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { aggregate, chartGroups, DISPLAY_METRICS, formatMetric, METRICS, type DisplayMetric, type Filters, type Grouping, type ProviderOption, type SessionRow } from "../shared/model";
import type { Session } from "../shared/schema";
import { ActivityCalendar } from "./activity-calendar";
import { Dropdown } from "./dropdown";

const GROUPS: { id: Grouping; label: string }[] = [{ id: "provider", label: "Provider" }, { id: "day", label: "Day" }, { id: "week", label: "Week (Monday)" }, { id: "month", label: "Month" }, { id: "project", label: "Project" }, { id: "model", label: "Model" }];
// Categorical hues in fixed order, stepped for light and dark surfaces. Every bar also carries its provider label.
export const SERIES_COLORS = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};
export function darkSurface(color: string): boolean {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
  const rgb = hex ? hex.slice(1).map((part) => Number.parseInt(part, 16)) : /^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/.exec(color)?.slice(1).map(Number);
  return rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128 : false;
}

export function Charts({ rows, sessions, providers, filters, onFiltersChange, theme, compact }: { rows: SessionRow[]; sessions: Session[]; providers: ProviderOption[]; filters: Filters; onFiltersChange(filters: Filters): void; theme: PluginTheme; compact: boolean }) {
  const [metric, setMetric] = useState<DisplayMetric>("totalTokens");
  const [grouping, setGrouping] = useState<Grouping>("provider");
  const [average, setAverage] = useState(false);
  const [limit, setLimit] = useState(14);
  const groups = useMemo(() => chartGroups(rows, grouping), [rows, grouping]);
  const lifetimeMetric = metric === "durationMs" || metric === "bytes";
  const restricted = lifetimeMetric && !["provider", "project"].includes(grouping);
  // Colors follow a provider's position among all providers in use, so filters never repaint a series.
  const palette = SERIES_COLORS[darkSurface(theme.colors.surface1) ? "dark" : "light"];
  const series = providers.map((provider, index) => ({ ...provider, color: palette[index] ?? theme.colors.foregroundMuted })).filter((provider) => rows.some((row) => row.session.provider === provider.id));
  const values = groups.map((group) => {
    const byProvider = new Map<string, SessionRow[]>();
    for (const row of group.rows) {
      const list = byProvider.get(row.session.provider);
      if (list) list.push(row); else byProvider.set(row.session.provider, [row]);
    }
    return { group, results: series.map((provider) => ({ provider, result: aggregate(byProvider.get(provider.id) ?? [], metric, average) })) };
  });
  const max = Math.max(...values.flatMap((v) => v.results.map(({ result }) => result.value ?? 0)), 0);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const temporal = ["day", "week", "month"].includes(grouping);
  const visible = temporal ? values.slice(-limit) : values.slice(0, limit);
  return <><View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: compact ? 12 : 16, gap: 12, backgroundColor: theme.colors.surface1 }}>
    <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>Compare providers</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Dropdown label="Metric" summary={METRICS[metric].label} options={DISPLAY_METRICS.map((id) => ({ id, label: METRICS[id].label }))} selected={new Set([metric])} multi={false} onToggle={(id) => setMetric(id as DisplayMetric)} theme={theme} compact={compact} />
      <Dropdown label="Group by" summary={GROUPS.find((g) => g.id === grouping)!.label} options={GROUPS} selected={new Set([grouping])} multi={false} onToggle={(id) => { setGrouping(id as Grouping); setLimit(14); }} theme={theme} compact={compact} />
      <Dropdown label="Show" summary={average ? "Per known session" : "Total"} options={[{ id: "total", label: "Total" }, { id: "average", label: "Per known session" }]} selected={new Set([average ? "average" : "total"])} multi={false} onToggle={(id) => setAverage(id === "average")} theme={theme} compact={compact} />
    </View>
    <Text style={muted}>{METRICS[metric].description}</Text>
    {restricted ? <Text style={muted}>Choose Provider or Project for lifetime measurements.</Text> : visible.length === 0 ? <Text style={muted}>No sessions match these filters.</Text> : <View style={{ gap: 16 }}>
      {visible.map(({ group, results }) => <View key={group.id} style={{ gap: 6 }}>
        {grouping !== "provider" ? <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{group.label}</Text> : null}
        {results.map(({ provider, result }) => <View key={provider.id} accessible accessibilityLabel={`${group.label}, ${provider.label}, ${METRICS[metric].label}: ${formatMetric(metric, result.value)}, ${result.known} of ${result.total} sessions have this measurement`} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{provider.label}</Text>
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{formatMetric(metric, result.value)} <Text style={muted}>· {result.known}/{result.total} known</Text></Text>
          </View>
          <View style={{ height: 12, borderRadius: 3, overflow: "hidden", backgroundColor: theme.colors.surface2 }}>
            <View style={{ height: 12, width: `${max && result.value !== null ? Math.min(100, result.value / max * 100) : 0}%`, borderRadius: 3, backgroundColor: provider.color }} />
          </View>
        </View>)}
      </View>)}
    </View>}
    {!restricted && groups.length > limit ? <Pressable accessibilityRole="button" onPress={() => setLimit(limit + 30)} style={{ minHeight: 36, justifyContent: "center" }}><Text style={{ color: theme.colors.accent, fontSize: 13 }}>Showing {temporal ? "latest " : ""}{visible.length} of {groups.length} groups · Show more</Text></Pressable> : null}
    <Text style={muted}>Bars start at zero on a shared scale. Values are known subtotals; “—” means unknown. Percentages use weighted totals. Dates use UTC.</Text>
  </View>
    <ActivityCalendar sessions={sessions} filters={filters} onChange={onFiltersChange} metric={metric} average={average} theme={theme} compact={compact} />
  </>;
}
