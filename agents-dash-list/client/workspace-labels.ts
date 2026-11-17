import type { PaseoApi } from "@getpaseo/client";

/**
 * Assigns or removes one workspace label through the SDK's workspace handle. `setLabel` arrived
 * on the handle in Paseo 0.16.0 (first in 0.16.0-beta.1, upstream PR #8906), after the version
 * this plugin types against and requires, so it is looked up at runtime: an app on 0.15 or older
 * answers with an error the dash can show instead of crashing, and everything else in the dash
 * keeps working there. The SDK
 * resolves the name against the host's own catalog (case-insensitively) and creates the label
 * there when it is new, so a label added on one host keeps whatever color that host gave it.
 */

type LabelHandle = {
  setLabel?: (name: string, options: { assigned: boolean }) => Promise<{ labels: string[] }>;
};

export class LabelsUnsupportedError extends Error {
  constructor() {
    super("Changing workspace labels from the dash needs Paseo 0.16.0 or later.");
    this.name = "LabelsUnsupportedError";
  }
}

export function canAssignLabels(api: PaseoApi | null): boolean {
  if (!api) return false;
  // `ref` only builds a handle; no request goes out for the probe id.
  try {
    return (
      typeof (api.workspaces.ref("capability-probe") as unknown as LabelHandle).setLabel ===
      "function"
    );
  } catch {
    return false;
  }
}

export async function assignWorkspaceLabel(
  api: PaseoApi,
  workspaceId: string,
  name: string,
  assigned: boolean,
): Promise<void> {
  const handle = api.workspaces.ref(workspaceId) as unknown as LabelHandle;
  if (typeof handle.setLabel !== "function") throw new LabelsUnsupportedError();
  await handle.setLabel.call(handle, name, { assigned });
}
