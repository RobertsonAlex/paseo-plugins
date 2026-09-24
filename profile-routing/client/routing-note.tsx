import type { PluginSurfaceProps, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Linking, Text } from "react-native";
import type { RoutingNoteData } from "../shared/routing-note";
import { agentDetailPath, openAgentPath } from "./web";

type TimelineProps = PluginTimelineItemProps<RoutingNoteData> & {
  navigation?: PluginSurfaceProps["navigation"];
};

function prefix(continued: boolean): { before: string; after: string } {
  return continued
    ? { before: "Continuing with", after: "in" }
    : { before: "Routing to", after: "as" };
}

async function openDelegate(
  hostId: string,
  agentId: string,
  openAgent?: (input: { agentId: string }) => void,
) {
  if (openAgent) {
    openAgent({ agentId });
    return;
  }
  const path = agentDetailPath(hostId, agentId);
  if (openAgentPath(path)) return;
  try {
    await Linking.openURL(`paseo:/${path}`);
  } catch (error) {
    console.error("profile-routing: could not open the routed agent", error);
  }
}

export function RoutingNote({ item, theme, host, navigation }: TimelineProps) {
  const note = item.data;
  const words = prefix(note.continued);
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
      link: { color: theme.colors.accent, fontSize: 13, lineHeight: 18 },
    }),
    [theme],
  );

  return (
    <Text style={styles.text}>
      {words.before} {note.modelId} ({note.provider}) {words.after}{" "}
      <Text
        accessibilityRole="link"
        accessibilityLabel={`Open agent ${note.delegateId}`}
        onPress={() => {
          void openDelegate(host.id, note.delegateId, navigation?.openAgent);
        }}
        style={styles.link}
      >
        {note.delegateId}
      </Text>
      .
    </Text>
  );
}
