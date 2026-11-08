import { useAtomValue } from '@effect/atom-react'
import { SearchResult, type MessageHit, type Thread } from '@vivid/contracts'
import { liveStateOf } from '@vivid/state'
import { Option } from 'effect'
import { useState, type ReactElement } from 'react'
import { FlatList, View } from 'react-native'
import { ChevronDown, ChevronRight, CircleCheck } from 'lucide-react-native'
import { useNow } from '../../data/foreground'
import { arrange, matching, Row, rowKey, rowsOf, type Lane } from '../../data/lanes'
import { LiveState, useLiveData } from '../../data/live'
import { readingPlace } from '../../data/reading'
import { useTheme } from '../../theme'
import { GUTTER, Label, Notice, Press, radius, Skeleton } from '../../ui/ui'
import { ThreadRow } from './Row'

/** What a row can do, the same for every list of Threads in the drawer. */
export interface ThreadActions {
  readonly onOpen: (thread: Thread) => void
  readonly onRename: (thread: Thread) => void
  /** Files a Thread in a Project; none where the Person has no Project to file it in. */
  readonly onFile: Option.Option<(thread: Thread) => void>
  /** What came of a row's quick action: a sentence when it was refused, none when it was not. */
  readonly onRefused: (message: Option.Option<string>) => void
}

interface ListProps extends ThreadActions {
  readonly query: string
  /** Drawn above the first lane and scrolled with it: the places beside Threads. */
  readonly header: ReactElement
  /** Said under the header when a scope leaves nothing to list; none when nothing is scoped. */
  readonly empty: Option.Option<string>
}

/**
 * A lane's heading, which folds and unfolds the lane. The whole line is pressed, and the chevron
 * at its far end says which way it stands, as the Done shelf at the foot of the list does. Only
 * the two attention lanes say how many they hold, and they go on saying it while folded.
 */
function Caption({
  label,
  count,
  folded,
  onFold,
}: {
  label: Lane['label']
  count: Option.Option<number>
  folded: boolean
  onFold: (label: Lane['label']) => void
}) {
  const { colors: c } = useTheme()
  const Chevron = folded ? ChevronRight : ChevronDown
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: !folded }}
      onPress={() => onFold(label)}
      containerStyle={{ marginTop: 10 }}
      style={({ pressed }) => ({
        // A finger's height, though the words are small: the heading is a control now.
        minHeight: 40,
        marginHorizontal: GUTTER - 12,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: radius.row,
        backgroundColor: pressed ? c['row-hover'] : 'transparent',
      })}
    >
      <Label size="caption" tone="drawer-foreground-muted" style={{ fontWeight: '600' }}>
        {label}
      </Label>
      {Option.isSome(count) && (
        <Label
          size="caption"
          tone="drawer-foreground-muted"
          style={{ fontVariant: ['tabular-nums'] }}
        >
          {count.value}
        </Label>
      )}
      <View style={{ flex: 1 }} />
      <Chevron pointerEvents="none" size={16} strokeWidth={1.7} color={c.chevron} />
    </Press>
  )
}

/** Threads the Person is done with, kept out of the way behind one row that says how many. */
function Shelf({
  done,
  now,
  ...actions
}: ThreadActions & { done: ReadonlyArray<Thread>; now: number }) {
  const { colors: c } = useTheme()
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View style={{ marginTop: 12 }}>
      <Press
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((shown) => !shown)}
        style={({ pressed }) => ({
          minHeight: 46,
          marginHorizontal: GUTTER - 12,
          paddingHorizontal: 12,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          borderRadius: radius.row,
          backgroundColor: pressed ? c['row-hover'] : 'transparent',
        })}
      >
        <CircleCheck
          pointerEvents="none"
          size={17}
          strokeWidth={1.7}
          color={c['drawer-foreground-muted']}
        />
        <Label tone="ink-2" style={{ flex: 1 }}>
          Done
        </Label>
        <Label
          size="label"
          tone="drawer-foreground-muted"
          style={{ fontVariant: ['tabular-nums'] }}
        >
          {done.length}
        </Label>
        <Chevron pointerEvents="none" size={16} strokeWidth={1.7} color={c.chevron} />
      </Press>
      {open &&
        done.map((thread) => <ThreadRow key={thread.id} thread={thread} now={now} {...actions} />)}
    </View>
  )
}

/** One sentence where a list would be, in the drawer's quiet ink. */
function Said({ children }: { children: string }) {
  return (
    <Label
      size="label"
      tone="drawer-foreground-muted"
      style={{ paddingHorizontal: GUTTER, paddingTop: 18 }}
    >
      {children}
    </Label>
  )
}

/**
 * One message found in the Person's conversations: the Thread it is in, and the words around the
 * match. Pressing it opens the Thread on that message, the way a Thread opens again where the
 * Person was reading (`data/reading.ts`): the message's row is put at the top of the list.
 */
function FoundRow({
  thread,
  hit,
  onOpen,
}: {
  thread: Thread
  hit: MessageHit
  onOpen: (thread: Thread) => void
}) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={`${thread.title}: ${hit.snippet}`}
      onPress={() => {
        readingPlace.keep(thread.id, { key: hit.messageId, offset: 0 })
        onOpen(thread)
      }}
      style={({ pressed }) => ({
        minHeight: 46,
        marginHorizontal: GUTTER - 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 2,
        borderRadius: radius.row,
        backgroundColor: pressed ? c['row-hover'] : 'transparent',
      })}
    >
      <Label numberOfLines={1}>{thread.title}</Label>
      <Label size="label" tone="drawer-foreground-muted" numberOfLines={2}>
        {hit.author === 'Person' ? `You: ${hit.snippet}` : hit.snippet}
      </Label>
    </Press>
  )
}

/**
 * Under the Threads a search matches, the messages it matches in the Person's conversations,
 * which the server finds (`Search`). The words live apart from the Threads' list and can be out
 * of reach while it is not, so that is said instead of passed off as nothing found.
 */
function FoundMessages({ onOpen }: { onOpen: (thread: Thread) => void }) {
  const data = useLiveData()
  const answer = liveStateOf(useAtomValue(data.findings))
  if (!LiveState.$is('Ready')(answer)) return null
  if (answer.value.messages === 'Unavailable')
    return <Said>Messages could not be searched right now.</Said>
  const found = answer.value.results.filter(SearchResult.guards.Message)
  if (found.length === 0) return null
  return (
    <View>
      <Label
        size="caption"
        tone="drawer-foreground-muted"
        style={{ paddingHorizontal: GUTTER, paddingTop: 18, paddingBottom: 4, fontWeight: '600' }}
      >
        In messages
      </Label>
      {found.map(({ thread, hit }) => (
        <FoundRow key={`${thread.id}:${hit.messageId}`} thread={thread} hit={hit} onOpen={onOpen} />
      ))}
    </View>
  )
}

/**
 * The Person's Threads, in the drawer. While searching it is every Thread that matches, flat,
 * then the messages that match in their conversations.
 * Otherwise it is the lanes: what needs the Person, what Vivid is working on, the rest by day,
 * and what is done on a shelf at the end.
 */
function Lanes({ threads, ...props }: ListProps & { threads: ReadonlyArray<Thread> }) {
  const now = useNow()
  // The lanes the Person folded. Kept for as long as the menu is, which is the signed-in app:
  // a lane folded once stays folded each time the menu is opened.
  const [folded, setFolded] = useState<ReadonlySet<Lane['label']>>(new Set())
  const fold = (label: Lane['label']) =>
    setFolded((was) => {
      const next = new Set(was)
      if (!next.delete(label)) next.add(label)
      return next
    })
  const searching = props.query.trim().length > 0
  const scrolling = {
    keyboardShouldPersistTaps: 'handled',
    keyboardDismissMode: 'on-drag',
    // Room for the floating Search and New thread under the last row.
    contentContainerStyle: { paddingBottom: 88 },
  } as const
  if (searching) {
    return (
      <FlatList
        {...scrolling}
        data={matching(threads, props.query)}
        keyExtractor={(thread) => thread.id}
        ListEmptyComponent={<Said>No thread matches that.</Said>}
        ListFooterComponent={<FoundMessages onOpen={props.onOpen} />}
        renderItem={({ item }) => <ThreadRow thread={item} now={now} {...props} />}
      />
    )
  }
  const arrangement = arrange(threads, now)
  return (
    <FlatList
      {...scrolling}
      data={rowsOf(arrangement.lanes, folded)}
      keyExtractor={rowKey}
      ListHeaderComponent={props.header}
      // A scope with no Threads says so; with no scope the header alone is the empty drawer.
      ListEmptyComponent={
        Option.isSome(props.empty) && arrangement.archived.length === 0 ? (
          <Said>{props.empty.value}</Said>
        ) : null
      }
      ListFooterComponent={
        arrangement.archived.length > 0 ? (
          <Shelf {...props} done={arrangement.archived} now={now} />
        ) : null
      }
      renderItem={({ item }) =>
        Row.$match(item, {
          Heading: ({ label, count, folded: shut }) => (
            <Caption label={label} count={count} folded={shut} onFold={fold} />
          ),
          Entry: ({ thread }) => <ThreadRow thread={thread} now={now} {...props} />,
        })
      }
    />
  )
}

/** The Threads as they stand: their outline while they load, why they cannot be read, or the list. */
export function Threads({
  state,
  ...props
}: ListProps & { state: LiveState<{ readonly threads: ReadonlyArray<Thread> }> }) {
  if (LiveState.$is('Loading')(state)) {
    return (
      <View>
        {props.header}
        <View style={{ paddingHorizontal: GUTTER, paddingTop: 24 }}>
          <Skeleton rows={5} />
        </View>
      </View>
    )
  }
  if (LiveState.$is('Failed')(state)) {
    return (
      <View>
        {props.header}
        <View style={{ padding: GUTTER }}>
          <Notice message={state.failure.message} />
        </View>
      </View>
    )
  }
  return <Lanes {...props} threads={state.value.threads} />
}
