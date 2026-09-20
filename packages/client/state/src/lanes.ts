// Extracted from the web Sidebar so native and web use the same grouping and priority.
type Conversation = {
  id: string
  pinned?: boolean
  status: 'ready' | 'working' | 'attention' | 'approve' | 'failed' | 'done'
  when: 'today' | 'yesterday' | 'week' | 'earlier'
  snoozeUntil?: string
}

export type Lane = {
  key: string
  label: string
  count?: boolean
  variant: 'card' | 'slim'
  pick: (conversation: Conversation) => boolean
}

export const LANES: Lane[] = [
  // Pinned wins first pick: a pinned conversation shows under Pinned even
  // when it also needs attention, instead of being consumed by an earlier lane.
  {
    key: 'pinned',
    label: 'Pinned',
    variant: 'card',
    pick: (conversation) => !!conversation.pinned,
  },
  {
    key: 'needs',
    label: 'Needs you',
    count: true,
    variant: 'card',
    pick: (conversation) =>
      conversation.status === 'attention' || conversation.status === 'approve',
  },
  {
    key: 'working',
    label: 'Working',
    count: true,
    variant: 'card',
    pick: (conversation) => conversation.status === 'working',
  },
  {
    key: 'today',
    label: 'Today',
    variant: 'slim',
    pick: (conversation) => conversation.when === 'today' && !conversation.snoozeUntil,
  },
  {
    key: 'yesterday',
    label: 'Yesterday',
    variant: 'slim',
    pick: (conversation) => conversation.when === 'yesterday' && !conversation.snoozeUntil,
  },
  {
    key: 'week',
    label: 'This week',
    variant: 'slim',
    pick: (conversation) => conversation.when === 'week' && !conversation.snoozeUntil,
  },
  {
    key: 'earlier',
    label: 'Earlier',
    variant: 'slim',
    pick: (conversation) => conversation.when === 'earlier' && !conversation.snoozeUntil,
  },
]

/** Groups each conversation into its first matching lane and keeps snoozed work separate. */
export function laneConversations<T extends Conversation>(list: T[]) {
  const taken = new Set<string>()
  // One pass per lane, in lane order: an earlier lane claims a thread before a later one sees it,
  // and a lane that claimed nothing is dropped rather than rendered empty.
  const lanes = LANES.flatMap((lane) => {
    const items = list.filter(
      (conversation) => !taken.has(conversation.id) && lane.pick(conversation),
    )
    for (const conversation of items) taken.add(conversation.id)
    return items.length > 0 ? [Object.assign({}, lane, { items })] : []
  })
  const snoozed = list.filter((conversation) => !!conversation.snoozeUntil)
  return { lanes, snoozed }
}
