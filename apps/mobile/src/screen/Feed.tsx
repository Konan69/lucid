import { useAtomValue } from '@effect/atom-react'
import {
  DisplaySource,
  FeedOpening,
  FeedPost,
  type Approval,
  type FeedAction,
  type FeedCardId,
  type ThreadId,
} from '@vivid/contracts'
import { allowing, feed, makeWhen, owed, thisReader, todos, type DeviceWaiting } from '@vivid/state'
import { Check } from 'lucide-react-native'
import { Array, Data, Option } from 'effect'
import { AsyncResult } from 'effect/reactivity'
import { useState, type ReactNode } from 'react'
import { FlatList, Pressable, View, type ViewToken } from 'react-native'
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated'
import { useApprovalDecision, useInbox } from '../data/approvals'
import { answer, close, makeResume, markSeen, resume, usePleased, usePresses } from '../data/feed'
import { closeOwed, useStandings } from '../data/owed'
import { closeTodo, useTodoStandings } from '../data/todos'
import { LiveState, useLive, useLiveData, useLiveValue } from '../data/live'
import { Computer } from './chat/Device'
import { Decide } from './feed/Decide'
import { Swipe, type Side, type Sides } from './feed/Swipe'
import { Display } from '../parts/display'
import { HoldMenu } from '../t3/Menu'
import { useTheme } from '../theme'
import { Composer } from '../ui/Composer'
import { Screen } from '../ui/Screen'
import { EDGE, Face, Label } from '../ui/ui'
import { useGo, useOpenThread } from '../workspace'
import { useStart } from './Home'

const when = makeWhen(thisReader())

/** Today as the head of the page says it: "Tuesday 20 October". */
const today = new Intl.DateTimeFormat(thisReader().locale, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

/**
 * The look Vivid's face holds on the Feed, for the state the Feed is in (`feed.feedFace`). The
 * phone's face is drawn in one mood at a time; these are the moods that open each state on the
 * web's living face (`@vivid/marks` `life.ts`).
 */
const LOOK = {
  done: 'happy',
  working: 'thinking',
  waiting: 'neutral',
  idle: 'neutral',
} as const

/**
 * What the Person chose in a waiting card's display, kept per card for the post it was chosen in.
 * The list draws only the rows near the screen, so a card scrolled away is unmounted; kept here,
 * its choices are back when it is drawn again, and a failed send is pressed again with the words
 * the Person picked. One entry per card: a new post replaces the old one, so the map holds no
 * more than the cards the Person has opened this session, each with its latest post's choices.
 */

const remembered = new Map<string, { readonly post: string; readonly chosen: feed.Chosen }>()

/** A card's way out and answer: 40 points tall, 12 corners, concentric with the card's 24. */
const ANSWER = { height: 40, radius: 12 } as const

/**
 * The Feed's rows: what the Person is waiting on under its caption, their own to-dos under theirs,
 * then the cards that need them under theirs, Vivid's work, and the one block of what is handled.
 */
type Row = Data.TaggedEnum<{
  Caption: { readonly words: string; readonly count: Option.Option<number> }
  Owed: { readonly record: owed.Waiting; readonly said: owed.OwedWords }
  Todo: { readonly todo: todos.Open; readonly due: todos.TodoWords }
  Computer: { readonly waiting: DeviceWaiting }
  Waiting: { readonly item: feed.Waiting }
  Working: { readonly item: feed.Working }
  Handled: { readonly items: ReadonlyArray<feed.Settled> }
}>
const Row = Data.taggedEnum<Row>()

/**
 * The Feed on the phone: the same Feed as the web (`apps/web/src/screen/Feed.tsx`), laid out for
 * one column, as the accepted design's phone frames are (13 October 2026, v8 then v9). The head is
 * the date and one sentence about what the Person is waiting on beside Vivid's face, with the
 * standing line under it; then the waiting-on list, each card that needs the Person, Vivid's work,
 * and what is handled; the composer stays at the foot.
 *
 * A card that waits counts as looked at once all of it has been on screen (`markSeen`, from the
 * list's own viewability event). Pressing a card's answer folds it out of the list while the
 * words go to its Thread, and Vivid's face is pleased for a moment.
 */
export function Feed() {
  const data = useLiveData()
  const openThread = useOpenThread()
  // The composer's height: it floats over the foot of the list, which keeps that much clear.
  const [foot, setFoot] = useState(0)
  const state = useLive(data.live.feed)
  const items = LiveState.$is('Ready')(state) ? state.value.items : []
  const view = feed.feedView(items, useLiveValue(data.live.devices))
  const pleased = usePleased((now) => now.pleased)
  const presses = usePresses((held) => held.presses)
  const standings = useStandings()
  const records = Option.match(useLiveValue(data.live.owed), {
    onNone: () => [],
    onSome: (list) => owed.waitingOf(list.owed),
  })
  // Deadlines and due dates are days in the Person's own zone, so their rows wait for it.
  const zone = Option.map(useLiveValue(data.live.settings), (settings) => settings.timezone)
  const toDo = Option.match(useLiveValue(data.live.todos), {
    onNone: () => [],
    onSome: (list) => todos.openOf(list.todos),
  })
  // The moment the page was opened, which every time on it is said against; read once.
  const [now] = useState(() => Date.now())
  const date = today.format(now)

  const inbox = useInbox()
  const { unstarted, onResume, onAnswered } = useResume(openThread)

  // A card that a press has folded leaves the list until Vivid posts again, and the count with it.
  const waiting =
    Option.toArray(view.computer).length +
    view.waiting.filter((item) => !feed.folds(item, Option.fromUndefinedOr(presses.get(item.card))))
      .length
  const rows = rowsOf(view, records, toDo, { zone, waiting })

  // One function for the list's life: FlatList refuses a viewability callback that changes. The
  // session's data does not change while this screen is up, so the first one serves.
  const [seen] = useState(() => (info: { viewableItems: ReadonlyArray<ViewToken<Row>> }) => {
    for (const token of info.viewableItems) {
      if (Row.$is('Waiting')(token.item) && !token.item.item.seen) markSeen(data, token.item.item)
    }
  })

  // A card counts as looked at once all of it is on screen, or, for a card taller than the
  // screen, once it fills most of it. FlatList takes the pairs once, so they are made once.
  const [looked] = useState(() => [
    { viewabilityConfig: { itemVisiblePercentThreshold: 99 }, onViewableItemsChanged: seen },
    { viewabilityConfig: { viewAreaCoveragePercentThreshold: 80 }, onViewableItemsChanged: seen },
  ])

  const head = <Head date={date} mood={LOOK[feed.feedFace(view, pleased)]} />

  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={Row.$match({
          Caption: ({ words }) => `caption:${words}`,
          Owed: ({ record }) => `owed:${record.id}`,
          Todo: ({ todo }) => `todo:${todo.id}`,
          Computer: ({ waiting: asking }) => `computer:${asking.device.id}`,
          // A new post is a new row: the display's own choices start again with it.
          Waiting: ({ item }) => `${item.card}:${feed.revisionOf(item)}`,
          Working: ({ item }) => item.card,
          Handled: () => 'handled',
        })}
        ListHeaderComponent={head}
        ListEmptyComponent={<Empty />}
        // Clear of the glass bar and its menu button, as every other page under it is; without
        // it the date and the greeting stood under the menu button.
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 + foot, gap: 12 }}
        scrollIndicatorInsets={{ bottom: foot }}
        viewabilityConfigCallbackPairs={looked}
        renderItem={({ item: row }) =>
          Row.$match(row, {
            Caption: ({ words, count }) => <Caption words={words} count={count} />,
            Owed: ({ record, said }) => (
              <OwedRow
                record={record}
                words={said}
                standing={Option.getOrElse(
                  Option.fromUndefinedOr(standings.get(record.id)),
                  (): owed.Standing => 'shown',
                )}
                now={now}
                onClose={(closing) => closeOwed(data, record.id, closing)}
                onOpen={() => openThread(record.threadId)}
              />
            ),
            Todo: ({ todo, due }) => (
              <TodoRow todo={todo} said={due} now={now} onOpen={() => openThread(todo.threadId)} />
            ),
            Computer: ({ waiting: asking }) => <Computer waiting={asking} now={now} />,
            Handled: ({ items: settled }) => (
              <Handled items={settled} now={now} onOpen={onResume} />
            ),
            Working: ({ item }) => (
              <Working
                item={item}
                now={now}
                unstarted={unstarted(item.thread)}
                onResume={() => onResume(item.thread)}
              />
            ),
            Waiting: ({ item }) => (
              <Waiting
                item={item}
                asked={feed.approvalOf(item, inbox)}
                press={Option.fromUndefinedOr(presses.get(item.card))}
                now={now}
                onAnswer={(words) => onAnswered(item.thread, words)}
                onDraw={(words) => answer(data, item, words)}
                onDone={() => close(data, item)}
                onOpen={() => openThread(item.thread)}
                unstarted={unstarted(item.thread)}
                onResume={() =>
                  feed.answeredInPlace(item) ? openThread(item.thread) : onResume(item.thread)
                }
              />
            ),
          })
        }
      />
      {/* Over the foot of the list, as a Thread's composer is: nothing behind it but the cards.
          The composer keeps the home indicator's inset itself. */}
      <Foot onHeight={setFoot} />
    </Screen>
  )
}

/**
 * The Feed's rows in order: what the Person is waiting on under its caption, their own to-dos under
 * theirs, then what needs them under theirs, Vivid's work, and what is handled. Every waiting card stays in the list, a folded
 * one drawn as nothing (`Waiting`), so what the Person chose in its display is still there if the
 * send fails and the card comes back; a closed record's row stays the same way until the list
 * drops it.
 */
const rowsOf = (
  view: feed.FeedView,
  records: ReadonlyArray<owed.Waiting>,
  toDo: ReadonlyArray<todos.Open>,
  {
    zone,
    waiting,
  }: {
    /** The Person's own zone: deadlines and due dates are days on their calendar, so rows wait for it. */
    readonly zone: Option.Option<string>
    /** How many wait on the Person now, said beside their caption. */
    readonly waiting: number
  },
): ReadonlyArray<Row> => [
  // A row says its deadline on the Person's calendar, so none is drawn before their settings are.
  ...Option.match(
    Option.filter(Option.map(zone, owed.owedWordsIn), () => records.length > 0),
    {
      onNone: () => [],
      onSome: (words) => [
        Row.Caption({ words: 'Waiting on', count: Option.none() }),
        ...records.map((record) => Row.Owed({ record, said: words })),
      ],
    },
  ),
  // A to-do's date is a day on the Person's calendar too, so its rows wait for the same zone.
  ...Option.match(
    Option.filter(Option.map(zone, todos.todoWordsIn), () => toDo.length > 0),
    {
      onNone: () => [],
      onSome: (due) => [
        Row.Caption({ words: 'To do', count: Option.none() }),
        ...toDo.map((todo) => Row.Todo({ todo, due })),
      ],
    },
  ),
  ...(Option.isSome(view.computer) || view.waiting.length > 0
    ? [Row.Caption({ words: 'For you', count: Option.some(waiting) })]
    : []),
  ...Option.toArray(view.computer).map((asking) => Row.Computer({ waiting: asking })),
  ...view.waiting.map((item) => Row.Waiting({ item })),
  ...view.working.map((item) => Row.Working({ item })),
  ...(view.settled.length > 0 ? [Row.Handled({ items: view.settled })] : []),
]

/** A section's caption: quiet, a heading to a screen reader, with its count beside it when it has one. */
function Caption({ words, count }: { words: string; count: Option.Option<number> }) {
  const { colors: c } = useTheme()
  return (
    <View
      accessibilityRole="header"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 4,
        marginTop: 4,
      }}
    >
      <Label size="label" tone="ink-3" style={{ fontWeight: '600' }}>
        {words}
      </Label>
      {Option.isSome(count) && (
        <View
          style={{
            minWidth: 20,
            height: 20,
            paddingHorizontal: 6,
            borderRadius: 10,
            backgroundColor: c.subtle,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Label size="caption" tone="ink-2" style={{ fontVariant: ['tabular-nums'] }}>
            {count.value}
          </Label>
        </View>
      )}
    </View>
  )
}

/**
 * The composer over the foot of the list, as a Thread's is: nothing behind it but the cards. It
 * keeps the home indicator's inset itself, and says how tall it is so the list keeps that clear.
 */
function Foot({ onHeight }: { onHeight: (height: number) => void }) {
  const go = useGo()
  const start = useStart()
  return (
    <View
      pointerEvents="box-none"
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
    >
      <Composer
        value={start.draft}
        autoFocus={false}
        placeholder="Message Vivid"
        working={false}
        disabled={false}
        attachments={Option.some(start.attachments)}
        dictation={start.microphone}
        onChange={start.setDraft}
        onSend={() => {
          // The new Thread opens on Home, where every Thread is read and written. Back to the
          // Home already under this page, as opening a Thread does (`useOpenThread`): a second
          // Home pushed over the Feed would bring the Feed back on Back and on the next launch.
          start.send()
          go.popTo('Home')
        }}
        onStop={() => undefined}
      />
    </View>
  )
}

/**
 * The head of the Feed: Vivid's face beside today's date, on the same left edge as the captions
 * under it. Nothing is said over them: what waits is the list itself, and the caption counts it
 * (the owner, 11 November 2026, of "4 things need you. The rest is handled.": "i dont like this").
 */
function Head({ date, mood }: { date: string; mood: (typeof LOOK)[keyof typeof LOOK] }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 4,
        paddingTop: 16,
      }}
    >
      <Face size={32} mood={mood} />
      <Label size="label" tone="ink-3">
        {date}
      </Label>
    </View>
  )
}

/** With nothing on the Feed at all: what the place is for, in one quiet line. */
function Empty() {
  return (
    <View style={{ paddingHorizontal: 4, paddingTop: 8, gap: 2 }}>
      <Label size="body" style={{ fontWeight: '600' }}>
        Nothing waiting
      </Label>
      <Label size="body" tone="ink-2" style={{ maxWidth: 300 }}>
        When Vivid needs your answer on something, it shows up here.
      </Label>
    </View>
  )
}

/**
 * One record of what the Person is waiting on: who and when on the first line, what under it, its
 * time as a line (`Track`), and what Vivid knows or does next. A tap opens the Thread it came
 * from; a hold offers the system menu (received, stop waiting, open), as the drawer's rows do. A
 * press folds the row out of the list while the server is asked, and a press that did not get
 * through brings it back saying so.
 */
function OwedRow({
  record,
  words,
  standing,
  now,
  onClose,
  onOpen,
}: {
  record: owed.Waiting
  /** The row's words, on the Person's own calendar (`owed.owedWordsIn`). */
  words: owed.OwedWords
  standing: owed.Standing
  now: number
  onClose: (closing: owed.Closing) => void
  onOpen: () => void
}) {
  const { colors: c } = useTheme()
  const folded = standing === 'folded'
  const timing = words.timing(record, now)
  return (
    <Animated.View
      pointerEvents={folded ? 'none' : 'auto'}
      accessibilityElementsHidden={folded}
      importantForAccessibility={folded ? 'no-hide-descendants' : 'auto'}
      layout={LinearTransition.duration(240).reduceMotion(ReduceMotion.System)}
      style={folded ? { height: 0, overflow: 'hidden', opacity: 0 } : undefined}
    >
      {standing === 'failed' && (
        <Label size="label" tone="status-danger" style={{ paddingBottom: 6, paddingHorizontal: 4 }}>
          Not sent. Try again.
        </Label>
      )}
      <HoldMenu
        title={record.what}
        actions={[
          { id: 'received', title: 'Received' },
          { id: 'drop', title: 'Stop waiting' },
          { id: 'open', title: 'Open the thread' },
        ]}
        onChoose={(id) => {
          if (id === 'received') onClose(owed.Closing.cases.Resolve.make({}))
          if (id === 'drop') onClose(owed.Closing.cases.Drop.make({}))
          if (id === 'open') onOpen()
        }}
        onPress={onOpen}
      >
        {({ pressed }) => (
          <View
            style={{
              paddingVertical: 10,
              paddingHorizontal: 4,
              borderRadius: 12,
              borderCurve: 'continuous',
              backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
              <Label size="body" numberOfLines={1} style={{ flex: 1, fontWeight: '600' }}>
                {record.from}
              </Label>
              <Label
                size="label"
                tone={timing.late ? 'status-danger' : 'ink-2'}
                style={{ fontVariant: ['tabular-nums'] }}
              >
                {timing.words}
              </Label>
            </View>
            <Label size="body" tone="ink-2" numberOfLines={2} style={{ marginTop: 2 }}>
              {record.what}
            </Label>
            <Track record={record} now={now} />
            <Label size="label" tone="ink-3" numberOfLines={2}>
              {words.detail(record, now)}
            </Label>
          </View>
        )}
      </HoldMenu>
    </Animated.View>
  )
}

/**
 * One to-do, built as a waiting-on row is (`OwedRow`) without its track: what to do, and when it
 * is due beside it when there is a date. A tap opens the Thread it was added in; a hold offers
 * the system menu (done, remove, open). A press folds the row out of the list while the server is
 * asked, and a press that did not get through brings it back saying so. The row reads its own
 * close machine's standing, so the Feed's list function stays one list.
 */
function TodoRow({
  todo,
  said,
  now,
  onOpen,
}: {
  todo: todos.Open
  /** The row's words on the Person's own calendar (`todos.todoWordsIn`). */
  said: todos.TodoWords
  now: number
  onOpen: () => void
}) {
  const { colors: c } = useTheme()
  const data = useLiveData()
  const standing = Option.getOrElse(
    Option.fromUndefinedOr(useTodoStandings().get(todo.id)),
    (): todos.Standing => 'shown',
  )
  const onClose = (closing: todos.Closing) => closeTodo(data, todo.id, closing)
  const folded = standing === 'folded'
  const due = Option.getOrUndefined(said.due(todo, now))
  return (
    <Animated.View
      pointerEvents={folded ? 'none' : 'auto'}
      accessibilityElementsHidden={folded}
      importantForAccessibility={folded ? 'no-hide-descendants' : 'auto'}
      layout={LinearTransition.duration(240).reduceMotion(ReduceMotion.System)}
      style={folded ? { height: 0, overflow: 'hidden', opacity: 0 } : undefined}
    >
      {standing === 'failed' && (
        <Label size="label" tone="status-danger" style={{ paddingBottom: 6, paddingHorizontal: 4 }}>
          Not sent. Try again.
        </Label>
      )}
      <HoldMenu
        title={todo.what}
        actions={[
          { id: 'done', title: 'Done' },
          { id: 'drop', title: 'Remove from list' },
          { id: 'open', title: 'Open the thread' },
        ]}
        onChoose={(id) => {
          if (id === 'done') onClose(todos.Closing.cases.Complete.make({}))
          if (id === 'drop') onClose(todos.Closing.cases.Drop.make({}))
          if (id === 'open') onOpen()
        }}
        onPress={onOpen}
      >
        {({ pressed }) => (
          <View
            style={{
              paddingVertical: 10,
              paddingHorizontal: 4,
              borderRadius: 12,
              borderCurve: 'continuous',
              backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 12 }}>
              <Label size="body" numberOfLines={2} style={{ flex: 1 }}>
                {todo.what}
              </Label>
              {due !== undefined && (
                <Label
                  size="label"
                  tone={due.late ? 'status-danger' : 'ink-2'}
                  style={{ fontVariant: ['tabular-nums'] }}
                >
                  {due.words}
                </Label>
              )}
            </View>
          </View>
        )}
      </HoldMenu>
    </Animated.View>
  )
}

/** A place on a track, as React Native's percentage offset. */
const pct = (fraction: number): `${number}%` => `${fraction * 100}%`

/**
 * A record's time as a line (`owed.trackOf`), the web's track at the phone's full width: a dot
 * where the waiting began, a ring at the last chase, a diamond on the due day and the tick for
 * now; what has passed is solid, what is ahead is a faint line, the days past due run red.
 * Decorative: the row's words say all of it.
 */
function Track({ record, now }: { record: owed.Waiting; now: number }) {
  const { colors: c } = useTheme()
  const track = owed.trackOf(record, now)
  const due = Option.getOrUndefined(track.due)
  const chased = Option.getOrUndefined(track.chased)
  const passed = due === undefined || track.late ? owed.TRACK_NOW : Math.min(owed.TRACK_NOW, due.at)
  const line = { position: 'absolute', top: 6, height: 2, borderRadius: 1 } as const
  const mark = {
    position: 'absolute',
    top: 2,
    width: 10,
    height: 10,
    marginLeft: -5,
    borderWidth: 2,
  } as const
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: 14, marginVertical: 8 }}
    >
      <View
        style={{
          ...line,
          left: pct(track.since.at),
          width: pct(passed - track.since.at),
          backgroundColor: c['ink-4'],
          opacity: track.since.clipped ? 0.5 : 1,
        }}
      />
      {due !== undefined && !track.late && (
        <View
          style={{
            ...line,
            left: pct(owed.TRACK_NOW),
            width: pct(due.at - owed.TRACK_NOW),
            backgroundColor: c['line-3'],
          }}
        />
      )}
      {due !== undefined && track.late && (
        <View
          style={{
            ...line,
            left: pct(due.at),
            width: pct(owed.TRACK_NOW - due.at),
            backgroundColor: c['status-danger'],
          }}
        />
      )}
      {!track.since.clipped && (
        <View
          style={{
            position: 'absolute',
            top: 4,
            left: pct(track.since.at),
            width: 6,
            height: 6,
            marginLeft: -3,
            borderRadius: 3,
            backgroundColor: c['ink-3'],
          }}
        />
      )}
      <View
        style={{
          position: 'absolute',
          top: -1,
          left: pct(owed.TRACK_NOW),
          width: 1,
          height: 16,
          backgroundColor: c['ink-3'],
        }}
      />
      {chased !== undefined && (
        <View
          style={{
            ...mark,
            left: pct(chased.at),
            borderRadius: 5,
            borderColor: c['ink-2'],
            backgroundColor: c.screen,
          }}
        />
      )}
      {due !== undefined && (
        <View
          style={{
            ...mark,
            left: pct(due.at),
            transform: [{ rotate: '45deg' }],
            borderColor: track.late ? c['status-danger'] : c['ink-2'],
            backgroundColor: c.screen,
          }}
        />
      )}
    </View>
  )
}

/**
 * A card that waits on the Person, as it stands with the press on it: it leaves the list while a
 * press is on its way or sent (the list filters it out), says so when a press did not get
 * through, and takes no second press while one is sending.
 */
function Waiting({
  item,
  asked,
  press,
  now,
  onAnswer,
  onDraw,
  onDone,
  onOpen,
  unstarted,
  onResume,
}: {
  item: feed.Waiting
  /** The Approval the work stopped on that this Person decides, if it did (`feed.approvalOf`). */
  asked: Option.Option<Approval>
  press: Option.Option<feed.Press>
  now: number
  /** The card's answer: a new chat about the work, where Vivid acts on it. */
  onAnswer: (words: FeedAction) => void
  /** A drawing's own button, said in the work's Thread. */
  onDraw: (words: string) => void
  onDone: () => void
  /** Opens the work's own Thread, where an ask is answered (the swipe's "Open"). */
  onOpen: () => void
  /** A press on this item did not start its new Conversation. */
  unstarted: boolean
  /** A press on the card: a new Conversation about its work, or its Thread (`answeredInPlace`). */
  onResume: () => void
}) {
  const post = Option.fromNullOr(item.post)
  // Folded by a press on this post: it takes no room and no touch, but stays mounted, so its
  // display keeps what the Person chose for when a failed send brings it back.
  const deciding = useApprovalDecision()
  // Decided here, the Approval is never pending again: the card folds until the Feed moves on.
  const folded =
    feed.folds(item, press) ||
    Option.exists(asked, (approval) => allowing.sentOn(deciding, approval.id))
  return (
    <Animated.View
      pointerEvents={folded ? 'none' : 'auto'}
      accessibilityElementsHidden={folded}
      importantForAccessibility={folded ? 'no-hide-descendants' : 'auto'}
      layout={LinearTransition.duration(360).reduceMotion(ReduceMotion.System)}
      style={folded ? { height: 0, overflow: 'hidden', opacity: 0 } : undefined}
    >
      {feed.failed(item, press) && (
        <Label size="label" tone="status-danger" style={{ paddingBottom: 8 }}>
          Not sent. Try again.
        </Label>
      )}
      {unstarted && <Unstarted />}
      <Swipe
        // A send that did not get through brings the card back where it was, not where it was thrown.
        key={feed.failed(item, press) ? 'again' : 'first'}
        sides={sidesOf(post, asked, { onSay: onAnswer, onDone, onOpen })}
        held={Option.exists(press, feed.Press.$is('Sending'))}
      >
        <Card
          card={item.card}
          at={item.at}
          post={post}
          ask={{ title: item.from, words: feed.askedWords(item) }}
          asked={Option.map(asked, (approval) => (
            <Decide approval={approval} />
          ))}
          reply={Option.some({
            // Only a send for this very post holds its buttons: an older post's send still on its
            // way does not stop the Person answering the one now shown.
            held: Option.exists(
              press,
              (held) => feed.Press.$is('Sending')(held) && held.revision === feed.revisionOf(item),
            ),
            onSay: onAnswer,
            onDraw,
            onDone,
          })}
          now={now}
          remember={Option.some({ post: feed.revisionOf(item) })}
          onOpen={onResume}
        />
      </Swipe>
    </Animated.View>
  )
}

/**
 * Pressing an item starts a new Conversation about its work and puts it in front (`makeResume`).
 * The screen owns the machine, because putting a Thread in front is its navigation.
 */
function useResume(openThread: (thread: ThreadId) => void) {
  const data = useLiveData()
  const [resumer] = useState(() => makeResume(data, openThread))
  const resuming = useAtomValue(resumer.result)
  return {
    unstarted: (work: ThreadId) =>
      AsyncResult.isSuccess(resuming) && feed.resumedOf(resuming.value, work) === 'unstarted',
    onResume: (work: ThreadId) => resume(data, resumer, work, FeedOpening.cases.Looking.make({})),
    onAnswered: (work: ThreadId, words: FeedAction) =>
      resume(data, resumer, work, FeedOpening.cases.Answered.make({ words })),
  }
}

/** Work Vivid is doing now; a press starts a new Conversation about it. */
function Working({
  item,
  now,
  unstarted,
  onResume,
}: {
  item: feed.Working
  now: number
  unstarted: boolean
  onResume: () => void
}) {
  return (
    <View>
      {unstarted && <Unstarted />}
      <Card
        card={item.card}
        at={item.since}
        post={Option.fromNullOr(item.post)}
        ask={{ title: item.from, words: 'Vivid is working on this now.' }}
        asked={Option.none()}
        reply={Option.none()}
        now={now}
        remember={Option.none()}
        onOpen={onResume}
      />
    </View>
  )
}

/** Said over an item whose press did not start its new Conversation; pressing it again tries it. */
function Unstarted() {
  return (
    <Label size="label" tone="status-danger" style={{ paddingBottom: 8 }}>
      Couldn’t start a chat about this. Try again.
    </Label>
  )
}

/**
 * What a swipe does on a waiting card, from what the card already offers (9 November 2026: swipe
 * the Feed's cards like a deck of cards). Right is the answer, left the way out, each in the card's
 * own words:
 *
 * - Left, on any posted card, dismisses it: the card is put away and nothing is said to Vivid, so
 *   no Run starts (the owner, 11 November 2026: "dismiss x should dismiss and ignore completely").
 *   It used to say the card's first button in its Thread, which woke Vivid and brought the card
 *   back with whatever it posted next.
 * - Right on a said card says its last button (the answer); on a card with none, or a drawn card
 *   whose answers live in the drawing, it puts the card away ("Done").
 * - Nothing posted (an ask read from its Thread, with no card row the server can mark): right
 *   opens the Thread, where it is answered, and the card settles back.
 * - An Approval to decide: no swipe. A consequential yes is pressed, never flung.
 */
function sidesOf(
  post: Option.Option<FeedPost>,
  asked: Option.Option<Approval>,
  reply: Pick<Reply, 'onSay' | 'onDone'> & { readonly onOpen: () => void },
): Sides {
  const done: Side = { words: 'Done', run: reply.onDone, ends: 'away' }
  const dismiss: Side = { words: 'Dismiss', run: reply.onDone, ends: 'away' }
  const open: Side = { words: 'Open', run: reply.onOpen, ends: 'back' }
  const say = (words: FeedAction): Side => ({ words, run: () => reply.onSay(words), ends: 'away' })
  if (Option.isSome(asked)) return { answer: Option.none(), away: Option.none() }
  return Option.match(post, {
    onNone: () => ({ answer: Option.some(open), away: Option.none() }),
    onSome: (made) => ({
      answer: Option.some(
        FeedPost.match(made, {
          Drawn: () => done,
          Said: ({ actions }) =>
            Option.match(Array.last(actions), { onNone: () => done, onSome: say }),
        }),
      ),
      away: Option.some(dismiss),
    }),
  })
}

/** How the Person answers a waiting card. A card Vivid is still working on takes no answer. */
interface Reply {
  /** A press is on its way: nothing more can be pressed. */
  readonly held: boolean
  /**
   * The card's answer, one of its buttons: a new chat about the work opens and Vivid acts on it
   * there (the owner, 11 November 2026: "it should always open in chat for now when i swipe yes
   * or click the approval button").
   */
  readonly onSay: (words: FeedAction) => void
  /** A drawing's own button: its words go to the work's Thread, as a reply's display does. */
  readonly onDraw: (words: string) => void
  /** Puts the card away without an answer. */
  readonly onDone: () => void
}

/**
 * Where a card came from, in Vivid's words, under its title: Muse's rule that every unasked item
 * says where it came from (`FeedFrom`). No post, or a card from before it was kept, says nothing.
 */
function Source({ post }: { post: Option.Option<FeedPost> }) {
  return Option.match(
    Option.flatMap(post, (made) => Option.fromNullOr(made.from)),
    {
      onNone: () => null,
      onSome: (from) => (
        <Label size="label" tone="ink-3" numberOfLines={1} style={{ marginTop: 2 }}>
          From {from}
        </Label>
      ),
    },
  )
}

/**
 * One card: a quiet row of where it is from (which opens the Thread) and when, then one of the
 * post's two cases (`FeedPost`), as on the web (`apps/web/src/screen/feed/Card.tsx`):
 *
 * - `Drawn`: Vivid's display is the whole card and its own Buttons answer in the Thread, as a
 *   reply's do. Nothing of ours is written above or under it (29 October 2026: "why does it look
 *   like we're containing the model?"); the row's "Done" puts it away.
 * - `Said`: nothing to draw, so the title, a sentence or two, and the card's buttons.
 */
function Card({
  card,
  at,
  post,
  ask,
  asked,
  reply,
  now,
  remember,
  onOpen,
}: {
  /** The card whose post this is; its display's programs run only as that post wrote them. */
  card: FeedCardId
  at: number
  post: Option.Option<FeedPost>
  ask: { readonly title: string; readonly words: string }
  /**
   * The Approval the work stopped on, to decide here (`Decide`), a send drawn as its draft: it
   * stands in for `ask.words`, or follows the post when there is one.
   */
  asked: Option.Option<ReactNode>
  reply: Option.Option<Reply>
  now: number
  /** Where this card's choices are kept across being scrolled away (`remembered`), if anywhere. */
  remember: Option.Option<{ readonly post: string }>
  onOpen: () => void
}) {
  const { colors: c } = useTheme()
  // What this card was drawn with: the choices kept from before it was scrolled away, if any. Read
  // once, so the renderer starts from it and is not handed a new start on every change.
  const [start] = useState<feed.Chosen>(() =>
    Option.getOrElse(
      Option.flatMap(remember, ({ post }) =>
        Option.map(
          Option.filter(Option.fromUndefinedOr(remembered.get(card)), (kept) => kept.post === post),
          (kept) => kept.chosen,
        ),
      ),
      () => ({}),
    ),
  )
  const choose = (next: feed.Chosen) => {
    Option.map(remember, ({ post }) => remembered.set(card, { post, chosen: next }))
  }
  const title = Option.match(post, { onNone: () => ask.title, onSome: (made) => made.title })
  const said = (words: string, actions: Option.Option<ReadonlyArray<FeedAction>>) => (
    <Said words={words} actions={actions} reply={reply} />
  )
  return (
    // A press anywhere on the card does what its title does. A press on anything of its own (a
    // button, the drawing's controls and fields) is taken by that first, as the innermost
    // touchable answers; `accessible={false}` keeps those reachable one by one, with the title
    // the control a screen reader uses.
    <Pressable
      accessible={false}
      onPress={onOpen}
      style={({ pressed }) => ({
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: EDGE,
        borderColor: c['line-2'],
        backgroundColor: c.card,
        padding: 16,
        overflow: 'hidden',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 22 }}>
        {/* What the card is about, which opens its Thread, then when at the trailing edge; the
            drawing and the words under it do not repeat the title (29 October 2026: "date on the
            right always", "you lost context"). */}
        <Pressable
          accessibilityRole="link"
          accessibilityHint="Opens the conversation"
          onPress={onOpen}
          hitSlop={8}
          style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.6 : 1 })}
        >
          <Label size="label" tone="ink-2" numberOfLines={1} style={{ fontWeight: '600' }}>
            {title}
          </Label>
        </Pressable>
        <Label size="label" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
          {when(at, now)}
        </Label>
        {Option.exists(post, FeedPost.guards.Drawn) && Option.isSome(reply) && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: reply.value.held }}
            disabled={reply.value.held}
            onPress={reply.value.onDone}
            hitSlop={10}
            style={({ pressed }) => ({
              marginLeft: 4,
              opacity: pressed || reply.value.held ? 0.5 : 1,
            })}
          >
            <Label size="label" tone="ink-2" style={{ fontWeight: '600' }}>
              Done
            </Label>
          </Pressable>
        )}
      </View>
      <Source post={post} />
      {Option.match(post, {
        onNone: () => Option.getOrElse(asked, () => said(ask.words, Option.none())),
        onSome: FeedPost.match({
          Drawn: ({ display }) => (
            <View style={{ marginTop: 12 }}>
              <Display
                source={DisplaySource.cases.FeedPost.make({ post: card })}
                text={display}
                arriving={false}
                live={Option.exists(reply, ({ held }) => !held)}
                onSay={(words) => Option.map(reply, ({ onDraw }) => onDraw(words))}
                onState={choose}
                initial={start}
              />
            </View>
          ),
          Said: ({ words, actions }) => said(words, Option.some(actions)),
        }),
      })}
      {Option.isSome(post) && Option.getOrNull(asked)}
    </Pressable>
  )
}

/**
 * A card with nothing drawn: under the header's title, what Vivid says, and on a waiting post its
 * buttons (`Answers`). The work's own state in words, with no post, has no buttons.
 */
function Said({
  words,
  actions,
  reply,
}: {
  words: string
  /** The post's buttons; none when Vivid posted nothing. */
  actions: Option.Option<ReadonlyArray<FeedAction>>
  reply: Option.Option<Reply>
}) {
  const bar = Option.zipWith(actions, reply, (labels, answering) => ({ labels, answering }))
  return (
    <>
      <Label size="body" textBreakStrategy="balanced" style={{ marginTop: 8 }}>
        {words}
      </Label>
      {Option.isSome(bar) && (
        <View
          style={{
            flexDirection: 'row',
            gap: 8,
            marginTop: 12,
            marginHorizontal: -4,
            marginBottom: -4,
          }}
        >
          <Answers actions={bar.value.labels} {...bar.value.answering} />
        </View>
      )}
    </>
  )
}

/**
 * A said card's buttons, as Vivid wrote them: the way out keeps to its words, the answer takes the
 * rest of the width (v9). A card with none gets "Done".
 */
function Answers({ actions, held, onSay, onDone }: { actions: ReadonlyArray<FeedAction> } & Reply) {
  if (actions.length === 0)
    return <Choice words="Done" primary={false} held={held} onPress={onDone} />
  const last = actions.length - 1
  return (
    <>
      {actions.map((words, place) => (
        <Choice
          // Each button is its place: the way out, then the answer.
          // oxlint-disable-next-line react/no-array-index-key
          key={place}
          words={words}
          primary={place === last}
          held={held}
          onPress={() => (place === last ? onSay(words) : onDone())}
        />
      ))}
    </>
  )
}

/** One of a card's buttons: the answer in the accent, the way out in its soft tint. */
function Choice({
  words,
  primary,
  held,
  onPress,
}: {
  words: string
  primary: boolean
  held: boolean
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: held }}
      disabled={held}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: primary ? 1 : undefined,
        minWidth: 0,
        height: ANSWER.height,
        borderRadius: ANSWER.radius,
        borderCurve: 'continuous',
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: primary ? c.accent : c['accent-soft'],
        opacity: held ? 0.5 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Label
        size="body"
        tone={primary ? 'ink-on-accent' : 'ink'}
        numberOfLines={1}
        style={{ fontWeight: primary ? '600' : '500' }}
      >
        {words}
      </Label>
    </Pressable>
  )
}

/** What is already handled: lines, not cards, each starting a new Conversation about its work. */
function Handled({
  items,
  now,
  onOpen,
}: {
  items: ReadonlyArray<feed.Settled>
  now: number
  onOpen: (thread: ThreadId) => void
}) {
  const { colors: c } = useTheme()
  return (
    <View style={{ marginTop: 12 }}>
      <Label
        size="label"
        tone="ink-3"
        style={{ fontWeight: '600', paddingHorizontal: 4, paddingBottom: 4 }}
      >
        Done
      </Label>
      {items.map((item, place) => (
        <Pressable
          key={item.card}
          accessibilityRole="link"
          onPress={() => onOpen(item.thread)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingVertical: 12,
            paddingHorizontal: 4,
            borderTopWidth: place === 0 ? 0 : EDGE,
            borderTopColor: c['line-1'],
            backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
          })}
        >
          <View
            style={{
              width: 20,
              height: 20,
              borderRadius: 10,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: c['status-success-soft'],
            }}
          >
            <Check size={11} strokeWidth={3} color={c['status-success']} />
          </View>
          <Label size="body" tone="ink-2" numberOfLines={1} style={{ flex: 1 }}>
            {Option.match(Option.fromNullOr(item.post), {
              onNone: () => item.from,
              onSome: (made) => made.title,
            })}
          </Label>
          <Label size="label" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
            {when(item.at, now)}
          </Label>
        </Pressable>
      ))}
    </View>
  )
}
