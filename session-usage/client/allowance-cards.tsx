import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { allowancePace, allowanceProviders, allowanceSeries, formatDuration, isSlotSelected, paceText, toggleAllowanceSlot, usedPercent, windowScope, windowSpan, type AllowanceSeries, type AllowanceSlot, type AllowanceWindow, type Allowances, type ProviderAllowance, type WindowSpan } from "../shared/allowance";
import { formatMetric, type Filters } from "../shared/model";
import type { Session } from "../shared/schema";
import { darkSurface, SERIES_COLORS } from "./charts";

const CHART_HEIGHT = 50;
const INPUT_HEIGHT = 31;
const OUTPUT_HEIGHT = CHART_HEIGHT - INPUT_HEIGHT - 1;
const SECTION_WIDTH = 150;
const SECTION_GAP = 16;

interface Props {
  allowances: Allowances | undefined;
  /** Every session on the host: the cards ignore the report filters. */
  sessions: Session[];
  filters: Filters;
  onFiltersChange(filters: Filters): void;
  theme: PluginTheme;
  compact: boolean;
}

export function AllowanceCards({ allowances, sessions, filters, onFiltersChange, theme, compact }: Props) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const providers = allowanceProviders(allowances, sessions);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  if (!providers.length) return allowances?.error ? <Text testID="allowance-error" style={muted}>Subscription allowances are unavailable. {allowances.error}</Text> : null;
  return <View testID="allowance-cards" style={{ gap: 10 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>Subscription allowances</Text>
      <Text style={muted}>Reported by Paseo{allowances?.fetchedAt ? ` ${formatDuration(now - Date.parse(allowances.fetchedAt))} ago` : ""} · all sessions on this host, regardless of filters</Text>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {providers.map((provider) => <ProviderCard key={provider.providerId} provider={provider} sessions={sessions} filters={filters} onFiltersChange={onFiltersChange} theme={theme} compact={compact} now={now} />)}
    </View>
  </View>;
}

function ProviderCard({ provider, sessions, filters, onFiltersChange, theme, compact, now }: Omit<Props, "allowances"> & { provider: ProviderAllowance; now: number }) {
  const padding = compact ? 12 : 14;
  const count = provider.windows.length;
  return <View testID={`allowance-card-${provider.providerId}`} style={{ width: compact ? "100%" : count * SECTION_WIDTH + (count - 1) * SECTION_GAP + 2 * padding + 2, maxWidth: "100%", borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding, gap: 10, backgroundColor: theme.colors.surface1 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600", flexShrink: 1 }}>{provider.displayName}</Text>
      {provider.planLabel ? <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: theme.colors.surface2 }}>{provider.planLabel}</Text> : null}
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: SECTION_GAP, rowGap: 14 }}>
      {provider.windows.map((window) => <WindowSection key={window.id} provider={provider} window={window} sessions={sessions} filters={filters} onFiltersChange={onFiltersChange} theme={theme} now={now} />)}
    </View>
  </View>;
}

function WindowSection({ provider, window, sessions, filters, onFiltersChange, theme, now }: Omit<Props, "allowances" | "compact"> & { provider: ProviderAllowance; window: AllowanceWindow; now: number }) {
  const span = windowSpan(window, now);
  const scope = windowScope(window);
  const series = span && scope.kind !== "unattributed" ? allowanceSeries(sessions, provider.providerId, scope, span, now) : null;
  const used = usedPercent(window);
  const pace = allowancePace(window, span, now);
  const text = { color: theme.colors.foreground, fontSize: 13 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const palette = SERIES_COLORS[darkSurface(theme.colors.surface1) ? "dark" : "light"];
  const colors = { input: palette[0], output: palette[1] };
  const tone = window.tone ?? (used === null ? "default" : used > 90 ? "danger" : used >= 70 ? "warning" : "default");
  const fill = { ok: theme.colors.statusSuccess, warning: theme.colors.statusWarning, danger: theme.colors.statusDanger, default: theme.colors.foregroundMuted }[tone];
  const elapsed = span && span.end > span.start ? Math.min(1, Math.max(0, (now - span.start) / (span.end - span.start))) : null;
  const resetIn = span ? span.end - now : null;
  const note = !span ? "No reset time"
    : scope.kind === "unattributed" ? "Not in local records"
    : !series?.hasTokens ? "No local token data"
    : scope.kind === "model" && !series.models.length ? `No ${scope.name} usage`
    : null;
  return <View testID={`allowance-window-${provider.providerId}-${window.id}`} style={{ width: SECTION_WIDTH, maxWidth: "100%", gap: 6 }}>
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
      <Text numberOfLines={1} style={{ ...text, fontWeight: "600", flexShrink: 1 }}>{window.label}</Text>
      {span ? <Text style={{ ...muted, fontSize: 11 }}>{span.hourly ? "by hour" : "by day"}</Text> : null}
    </View>
    {note || !series ? <View style={{ height: CHART_HEIGHT, justifyContent: "center", borderRadius: 6, borderWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border, paddingHorizontal: 6 }}><Text numberOfLines={2} style={{ ...muted, fontSize: 11, textAlign: "center" }}>{note}</Text></View>
      : <TokenChart series={series} providerId={provider.providerId} span={span!} filters={filters} onFiltersChange={onFiltersChange} theme={theme} colors={colors} />}
    <View accessible accessibilityRole="progressbar" accessibilityLabel={`${window.label}: ${used === null ? "usage unknown" : `${Math.round(used)}% used`}${resetIn !== null ? `, resets in ${formatDuration(resetIn)}` : ""}`} style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <Text style={{ ...text, fontWeight: "500" }}>{used === null ? "—" : `${Math.round(Math.min(100, Math.max(0, used)))}%`}</Text>
        {resetIn !== null ? <Text numberOfLines={1} style={muted}>{resetIn > 0 ? `resets in ${formatDuration(resetIn)}` : "resetting"}</Text> : null}
      </View>
      <View style={{ height: 10, justifyContent: "center" }}>
        <View style={{ height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: theme.colors.surface2 }}>
          <View style={{ height: 4, borderRadius: 2, width: `${Math.min(100, Math.max(0, used ?? 0))}%`, backgroundColor: fill }} />
        </View>
        {/* Elapsed share of the window: usage to the right of the mark is ahead of time. */}
        {elapsed !== null ? <View pointerEvents="none" style={{ position: "absolute", left: `${elapsed * 100}%`, width: 2, height: 10, marginLeft: -1, borderRadius: 1, backgroundColor: theme.colors.foreground }} /> : null}
      </View>
    </View>
    {paceText(pace) ? <Text testID={`allowance-pace-${provider.providerId}-${window.id}`} style={{ ...muted, color: pace.kind === "runsOut" || pace.kind === "exhausted" ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>{paceText(pace)}</Text> : null}
  </View>;
}

/** Input rises above the baseline and output hangs below it, each half scaled to its own maximum. */
function TokenChart({ series, providerId, span, filters, onFiltersChange, theme, colors }: {
  series: AllowanceSeries; providerId: string; span: WindowSpan; filters: Filters; onFiltersChange(filters: Filters): void;
  theme: PluginTheme; colors: { input: string; output: string };
}) {
  const height = (value: number, max: number, room: number) => value > 0 && max > 0 ? Math.max(1, Math.round(value / max * room)) : 0;
  return <View testID="allowance-chart" style={{ height: CHART_HEIGHT, flexDirection: "row", gap: series.slots.length > 12 ? 1 : 2 }}>
    {series.slots.map((slot) => {
      const selected = isSlotSelected(filters, providerId, slot, series.models);
      return <Pressable key={slot.key} testID={`allowance-slot-${slot.key}`} accessibilityRole="button" accessibilityLabel={describeSlot(slot, span)} accessibilityHint={selected ? "Clear the report's date filter" : "Focus the report on this period"} aria-selected={selected} disabled={slot.future} aria-disabled={slot.future}
        onPress={() => onFiltersChange(toggleAllowanceSlot(filters, providerId, slot, series.models))}
        style={{ flex: 1, minWidth: 0, borderRadius: 2, backgroundColor: selected ? theme.colors.surface2 : "transparent", borderWidth: selected ? 1 : 0, borderColor: theme.colors.foreground, opacity: slot.future ? 0.45 : 1 }}>
        <View style={{ height: INPUT_HEIGHT, justifyContent: "flex-end", paddingHorizontal: selected ? 0 : 1 }}>
          <View style={{ height: height(slot.inputTokens, series.maxInput, INPUT_HEIGHT - 1), borderTopLeftRadius: 1, borderTopRightRadius: 1, backgroundColor: colors.input }} />
        </View>
        <View style={{ height: 1, backgroundColor: slot.future ? theme.colors.border : theme.colors.foregroundMuted }} />
        <View style={{ height: OUTPUT_HEIGHT, paddingHorizontal: selected ? 0 : 1 }}>
          <View style={{ height: height(slot.outputTokens, series.maxOutput, OUTPUT_HEIGHT - 1), borderBottomLeftRadius: 1, borderBottomRightRadius: 1, backgroundColor: colors.output }} />
        </View>
      </Pressable>;
    })}
  </View>;
}

/** Screen reader label; the chart has no visible values. */
function describeSlot(slot: AllowanceSlot, span: WindowSpan): string {
  const day = new Date(slot.start).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const hour = slot.key.slice(11);
  const label = `${span.hourly ? `${day}, ${hour}–${String((Number(hour.slice(0, 2)) + 1) % 24).padStart(2, "0")}:00` : day} UTC`;
  if (slot.future) return `${label} · Not yet reached`;
  if (!slot.measured) return `${label} · No recorded tokens`;
  const input = formatMetric("inputTokens", slot.inputTokens, true);
  return `${label} · ${input} input (${formatMetric("cacheReadTokens", slot.cacheReadTokens, true)} cache read, ${formatMetric("uncachedTokens", slot.uncachedTokens, true)} uncached) · ${formatMetric("outputTokens", slot.outputTokens, true)} output · ${formatMetric("estimatedCostUsd", slot.estimatedCostUsd)} API estimate · ${slot.measured} session${slot.measured === 1 ? "" : "s"}`;
}
