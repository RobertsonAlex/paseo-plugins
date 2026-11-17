import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { type GestureResponderEvent, Pressable, StyleSheet, View } from "react-native";

/**
 * A small selection box. It usually sits inside a larger pressable (a row, a group header), so
 * its press is stopped from reaching that parent on web; native ignores the call. `mixed` draws
 * the dash a group header shows when only some of its rows are selected.
 */

export type CheckState = "checked" | "unchecked" | "mixed";

const BOX_SIZE = 16;

export function Checkbox({
  state,
  label,
  theme,
  onToggle,
}: {
  state: CheckState;
  /** Screen-reader name, e.g. "Select api-refactor". */
  label: string;
  theme: PluginTheme;
  onToggle(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const filled = state !== "unchecked";
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: state === "mixed" ? "mixed" : state === "checked" }}
      hitSlop={8}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={(event?: GestureResponderEvent) => {
        event?.stopPropagation?.();
        onToggle();
      }}
      style={styles.target}
    >
      <View
        style={[
          styles.box,
          {
            borderColor: filled || hovered ? theme.colors.accent : theme.colors.foregroundMuted,
            backgroundColor: filled ? theme.colors.accent : theme.colors.surface0,
          },
        ]}
      >
        {state === "checked" ? (
          <Icon name="Check" size={12} color={theme.colors.accentForeground} />
        ) : state === "mixed" ? (
          <Icon name="Minus" size={12} color={theme.colors.accentForeground} />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: { width: 20, height: 20, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  box: {
    width: BOX_SIZE,
    height: BOX_SIZE,
    borderRadius: 4,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
});
