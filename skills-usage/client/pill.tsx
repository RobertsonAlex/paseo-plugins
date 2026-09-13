import type {
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { aggregateSkillUses } from "../shared/skills";
import { SkillsPopover } from "./skills-popover";
import { useAvailableSkills, useSkillUses } from "./use-skills";
import { registerComposerAnchor } from "./web";

const AGENT_PAGE_SIZE = 200;

/** The agent fields the pill needs; structural so the bundle has no SDK type dependency. */
interface AgentLike {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
}

/** Stream handle a `list({ subscribe: {} })` call returns; the pinned SDK types omit it. */
interface OwnedSubscription {
  release(): Promise<void>;
}

function takeSubscription(result: unknown): OwnedSubscription | null {
  const candidate = (result as { subscription?: unknown }).subscription;
  return candidate && typeof (candidate as OwnedSubscription).release === "function"
    ? (candidate as OwnedSubscription)
    : null;
}
const PILL_ID = "skills";
const PILL_TITLE = "Browse the skills available to this agent";

/**
 * Paseo renders the pill chrome and label; the count reaches the label through the
 * registration. The icon mounts only while the pill is on screen, so the timeline scan is
 * scoped to visible agents. On web the icon's DOM node also anchors composer insertion.
 */
function SkillsIcon({
  host,
  agentId,
  size,
  color,
  onCount,
}: PluginButtonIconProps & { agentId: string; onCount: (count: number) => void }) {
  const anchor = useRef<View>(null);
  const available = useAvailableSkills(host.id, agentId);
  const uses = useSkillUses(host.id, agentId);
  const count = useMemo(() => {
    if (!uses.data) return undefined;
    const names = new Set((available.data?.skills ?? []).map((skill) => skill.name));
    return aggregateSkillUses(uses.data, names).size;
  }, [available.data, uses.data]);

  useEffect(() => registerComposerAnchor(agentId, anchor.current), [agentId]);
  useEffect(() => {
    if (count !== undefined) onCount(count);
  }, [count, onCount]);

  return (
    <View ref={anchor} collapsable={false}>
      <Icon name="Sparkles" size={size} color={color} />
    </View>
  );
}

function pillLabel(count: number): string {
  return count > 0 ? `Skills · ${count}` : "Skills";
}

interface RegisteredPill {
  workspaceId: string;
  remove: () => void;
}

export function contributePills(client: PluginClientContext) {
  const pills = new Map<string, RegisteredPill>();
  let stopped = false;

  function remove(agentId: string) {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  }

  function upsert(agent: AgentLike) {
    if (stopped || !agent.workspaceId || agent.archivedAt) {
      remove(agent.id);
      return;
    }
    const existing = pills.get(agent.id);
    if (existing?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    const { id: agentId, workspaceId } = agent;
    let registration: PluginButtonRegistration | null = null;
    let label = pillLabel(0);
    const report = (count: number) => {
      const next = pillLabel(count);
      if (next === label) return;
      label = next;
      registration?.update({ label: next });
    };
    registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId,
      button: {
        title: PILL_TITLE,
        icon: (props) => <SkillsIcon {...props} agentId={agentId} onCount={report} />,
        label,
        behavior: { kind: "popover", Content: SkillsPopover },
      },
    });
    const current = registration;
    pills.set(agentId, { workspaceId, remove: () => current.remove() });
  }

  // The SDK's `subscribe` handlers only relay updates from an open `list({ subscribe })`
  // stream, so register the handler first and open the stream on the first page. The host
  // assigns the subscription ID; passing one is rejected.
  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") remove(update.agentId);
    else upsert(update.agent);
  });
  const subscriptions: OwnedSubscription[] = [];

  void seedAgents(client, upsert, (subscription) => {
    if (stopped) void subscription.release().catch(() => undefined);
    else subscriptions.push(subscription);
  });

  return () => {
    stopped = true;
    unsubscribe();
    for (const subscription of subscriptions.splice(0)) {
      void subscription.release().catch(() => undefined);
    }
    for (const agentId of [...pills.keys()]) remove(agentId);
  };
}

async function seedAgents(
  client: PluginClientContext,
  upsert: (agent: AgentLike) => void,
  onSubscription: (subscription: OwnedSubscription) => void,
) {
  try {
    let cursor: string | undefined;
    do {
      const response = await client.paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: AGENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
        ...(cursor ? {} : { subscribe: {} }),
      });
      if (!cursor) {
        const subscription = takeSubscription(response);
        if (subscription) onSubscription(subscription);
      }
      for (const { agent } of response.entries) upsert(agent);
      cursor = response.pageInfo.hasMore ? (response.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
  } catch (error) {
    console.error("[skills-usage] could not list agents", error);
  }
}
