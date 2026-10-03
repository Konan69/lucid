import type { Thread } from '@vivid/contracts'
import { Option } from 'effect'
import { useState, type ReactElement } from 'react'
import { FlatList, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { ChevronDown, ChevronRight, CircleCheck } from 'lucide-react-native'
import { useNow } from '../../data/foreground'
import { arrange, matching, Row, rowKey, rowsOf } from '../../data/lanes'
import { LiveState } from '../../data/live'
import { useTheme } from '../../theme'
import { GUTTER, Label, Notice, Press, radius, Skeleton } from '../../ui/ui'
import { ThreadRow } from './Row'

/** What a row can do, the same for every list of Threads in the drawer. */
export interface ThreadActions {
  /** How wide the list is, for a row's full swipe. */
  readonly width: number
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
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
}

/** A lane's heading. Only the two attention lanes say how many they hold. */
function Caption({ label, count }: { label: string; count: Option.Option<number> }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 6,
        paddingHorizontal: GUTTER,
        paddingTop: 18,
        paddingBottom: 6,
      }}
    >
      <Label
        accessibilityRole="header"
        size="caption"
        tone="drawer-foreground-muted"
        style={{ fontWeight: '600' }}
      >
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
    </View>
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
        done.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} variant="line" now={now} {...actions} />
        ))}
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
 * The Person's Threads, in the drawer. While searching it is every Thread that matches, flat.
 * Otherwise it is the lanes: what needs the Person, what Vivid is working on, the rest by day,
 * and what is done on a shelf at the end.
 */
function Lanes({ threads, ...props }: ListProps & { threads: ReadonlyArray<Thread> }) {
  const now = useNow()
  const searching = props.query.trim().length > 0
  const scrolling = {
    keyboardShouldPersistTaps: 'handled',
    keyboardDismissMode: 'on-drag',
    scrollEventThrottle: 16,
    onScroll: props.onScroll,
    // Room for the floating "New thread" under the last row.
    contentContainerStyle: { paddingBottom: 88 },
  } as const
  if (searching) {
    return (
      <FlatList
        {...scrolling}
        data={matching(threads, props.query)}
        keyExtractor={(thread) => thread.id}
        ListEmptyComponent={<Said>No thread matches that.</Said>}
        renderItem={({ item }) => <ThreadRow thread={item} variant="line" now={now} {...props} />}
      />
    )
  }
  const arrangement = arrange(threads, now)
  return (
    <FlatList
      {...scrolling}
      data={rowsOf(arrangement.lanes)}
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
          Heading: ({ label, count }) => <Caption label={label} count={count} />,
          Entry: ({ thread, variant }) => (
            <ThreadRow thread={thread} variant={variant} now={now} {...props} />
          ),
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
