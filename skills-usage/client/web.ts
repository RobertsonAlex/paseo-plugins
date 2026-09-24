import { Platform } from "react-native";

// Minimal DOM shapes; the plugin tsconfig has no DOM lib, and every export below is gated on web.
interface DomNode {
  parentElement: DomNode | null;
  querySelectorAll(selector: string): ArrayLike<DomTextArea>;
}

interface DomTextArea extends DomNode {
  value: string;
  isConnected: boolean;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  dispatchEvent(event: unknown): boolean;
  getClientRects(): ArrayLike<unknown>;
}

interface DomDocument {
  activeElement: unknown;
  querySelectorAll(selector: string): ArrayLike<DomTextArea>;
}

declare const document: DomDocument | undefined;
declare const Event: new (type: string, init?: { bubbles?: boolean }) => unknown;
declare const HTMLTextAreaElement: { prototype: object } | undefined;

const anchors = new Map<string, DomNode>();

function isWeb(): boolean {
  return Platform.OS === "web" && typeof document !== "undefined";
}

function visibleTextAreas(node: DomNode | DomDocument): DomTextArea[] {
  const all = Array.from(node.querySelectorAll("textarea"));
  return all.filter((area) => area.isConnected && area.getClientRects().length > 0);
}

/**
 * Remembers the pill's DOM position for an agent. The composer text area is found later by
 * climbing from this node, so split views with several composers resolve to the right one.
 */
export function registerComposerAnchor(agentId: string, node: unknown): () => void {
  if (!isWeb() || !node || typeof node !== "object") return () => {};
  anchors.set(agentId, node as DomNode);
  return () => {
    if (anchors.get(agentId) === node) anchors.delete(agentId);
  };
}

function findComposer(agentId: string): DomTextArea | null {
  if (!isWeb() || !document) return null;
  let node = anchors.get(agentId) ?? null;
  while (node) {
    const areas = visibleTextAreas(node);
    if (areas.length === 1) return areas[0] ?? null;
    if (areas.length > 1) break;
    node = node.parentElement;
  }
  const areas = visibleTextAreas(document);
  const active = areas.find((area) => area === document?.activeElement);
  if (active) return active;
  return areas.length === 1 ? (areas[0] ?? null) : null;
}

function setNativeValue(area: DomTextArea, value: string): void {
  const prototype = typeof HTMLTextAreaElement === "undefined" ? null : HTMLTextAreaElement?.prototype;
  const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : undefined;
  if (setter) setter.call(area, value);
  else area.value = value;
}

export function focusComposer(agentId: string): void {
  const area = findComposer(agentId);
  if (!area) return;
  area.focus();
  const end = area.value.length;
  try {
    area.setSelectionRange(end, end);
  } catch {
    // Some inputs reject selection changes while unfocused; focus alone is fine.
  }
}

/**
 * Appends text to the agent's composer draft on web. Returns false when there is no DOM
 * composer to write to, so the caller can fall back to the clipboard.
 */
export function insertComposerText(agentId: string, text: string): boolean {
  const area = findComposer(agentId);
  if (!area) return false;
  const current = area.value;
  const separator = current.length === 0 || /\s$/.test(current) ? "" : " ";
  const next = `${current}${separator}${text} `;
  setNativeValue(area, next);
  area.dispatchEvent(new Event("input", { bubbles: true }));
  area.focus();
  try {
    area.setSelectionRange(next.length, next.length);
  } catch {
    // Selection is cosmetic; the text is already in the draft.
  }
  return true;
}
