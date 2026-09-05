// Extracted from Sidebar.tsx so native and web use the same grouping and priority.
type Conversation = {
  id: string;
  pinned?: boolean;
  status: "ready" | "working" | "attention" | "approve" | "failed" | "done";
  when: "today" | "yesterday" | "week" | "earlier";
  snoozeUntil?: string;
};
export type Lane = { key: string; label: string; count?: boolean; variant: "card" | "slim"; pick: (t: Conversation) => boolean };
export const LANES: Lane[] = [
  // Pinned wins first pick: a pinned conversation shows under Pinned even
  // when it also needs attention, instead of being consumed by an earlier lane.
  { key: "pinned", label: "Pinned", variant: "card", pick: (t) => !!t.pinned },
  { key: "needs", label: "Needs you", count: true, variant: "card", pick: (t) => t.status === "attention" || t.status === "approve" },
  { key: "working", label: "Working", count: true, variant: "card", pick: (t) => t.status === "working" },
  { key: "today", label: "Today", variant: "slim", pick: (t) => t.when === "today" && !t.snoozeUntil },
  { key: "yesterday", label: "Yesterday", variant: "slim", pick: (t) => t.when === "yesterday" && !t.snoozeUntil },
  { key: "week", label: "This week", variant: "slim", pick: (t) => t.when === "week" && !t.snoozeUntil },
  { key: "earlier", label: "Earlier", variant: "slim", pick: (t) => t.when === "earlier" && !t.snoozeUntil },
];

export function laneConversations<T extends Conversation>(list: T[]) {
  const taken = new Set<string>();
  const lanes = LANES.map((l) => {
    const items = list.filter((t) => !taken.has(t.id) && l.pick(t));
    for (const t of items) taken.add(t.id);
    return { ...l, items };
  }).filter((l) => l.items.length > 0);
  const snoozed = list.filter((t) => !!t.snoozeUntil);
  return { lanes, snoozed };
}
