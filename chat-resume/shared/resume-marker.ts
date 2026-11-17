/** Agent metadata key (Paseo 0.16) that marks a scheduled resume; the schedule store stays the source of truth. */
export const RESUME_METADATA_KEY = "chat-resume.resume";

export interface ResumeMarker {
  scheduleId: string;
  at: string;
}

/** The marker on an agent snapshot, or null when absent or malformed. */
export function readResumeMarker(agent: object): ResumeMarker | null {
  const metadata = (agent as { metadata?: unknown }).metadata as Record<string, unknown> | null | undefined;
  const value = metadata?.[RESUME_METADATA_KEY] as { scheduleId?: unknown; at?: unknown } | null | undefined;
  if (!value || typeof value.scheduleId !== "string" || typeof value.at !== "string") return null;
  return { scheduleId: value.scheduleId, at: value.at };
}

/**
 * The metadata patch that makes an agent's marker match its pending heartbeat, or null when it
 * already does. `null` removes the key.
 */
export function reconcileResumeMarker(
  marker: ResumeMarker | null,
  heartbeat: { id: string; nextRunAt: string | null } | undefined,
): Record<string, ResumeMarker | null> | null {
  if (!heartbeat) return marker ? { [RESUME_METADATA_KEY]: null } : null;
  if (marker?.scheduleId === heartbeat.id) return null;
  return { [RESUME_METADATA_KEY]: { scheduleId: heartbeat.id, at: heartbeat.nextRunAt ?? new Date().toISOString() } };
}
