/**
 * How the agent's latest turn ended, read from its timeline tail.
 *
 * A provider that stops on quota says so in its last message, and `usage.ts` reads that text. This
 * module covers the other stop: the turn simply ends mid-work — the daemon restarted, the provider
 * process exited, the machine went down — and the agent is left idle with nothing said.
 */
export type TurnState =
  /** The turn ended with something said: an assistant message or a provider error. */
  | "spoken"
  /** Work happened after the last thing said, and then the turn stopped. */
  | "unfinished"
  /** The turn produced no output at all, not even a tool call. */
  | "silent"
  /** Someone interrupted the turn, or the provider reported it cancelled. */
  | "aborted"
  /** The tail says nothing either way. */
  | "unknown";

/** The fields of a timeline item this classification reads. */
export interface TurnTimelineItem {
  type: string;
  text?: string;
  status?: string;
}

/** Thoughts, todo lists, and compactions trail a finished turn, so they never decide its state. */
const NEUTRAL_TYPES = new Set(["reasoning", "todo", "compaction"]);

/**
 * Classifies the latest turn from the tail of a timeline, newest item last. The tail may start
 * mid-turn; a page that shows only work and no prompt is still an unfinished turn.
 */
export function classifyTurnTail(items: readonly TurnTimelineItem[]): TurnState {
  let worked = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || NEUTRAL_TYPES.has(item.type)) continue;
    switch (item.type) {
      case "assistant_message":
        // An empty assistant frame carries a tool call, not speech.
        if (!item.text || !item.text.trim()) continue;
        return worked ? "unfinished" : "spoken";
      case "error":
        // A turn that ends on a provider error has spoken: the usage patterns read that error.
        return worked ? "unfinished" : "spoken";
      case "tool_call":
        if (item.status === "canceled") return "aborted";
        worked = true;
        continue;
      case "user_message":
        return worked ? "unfinished" : "silent";
      default:
        continue;
    }
  }
  return worked ? "unfinished" : "unknown";
}

export const UNFINISHED_PROMPT =
  "The previous turn stopped before it finished. Review the latest conversation and the workspace state, then continue the unfinished work and report what you did.";
