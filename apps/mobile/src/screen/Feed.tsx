import { DisplaySource, type FeedCardId, type FeedPost, type ThreadId } from '@vivid/contracts'
import { feed, greetingAt, makeWhen, thisReader, type DeviceWaiting } from '@vivid/state'
import { Check } from 'lucide-react-native'
import { Data, Option } from 'effect'
import { useState, type ReactNode } from 'react'
import { FlatList, Pressable, View, type ViewToken } from 'react-native'
import Animated, { LinearTransition, ReduceMotion } from 'react-native-reanimated'
import { answer, close, markSeen, usePleased, usePresses } from '../data/feed'
import { LiveState, useLive, useLiveData, useLiveValue } from '../data/live'
import { Computer } from './chat/Device'
import { Display } from '../parts/display'
import { useTheme } from '../theme'
import { Composer } from '../ui/Composer'
import { Screen } from '../ui/Screen'
import { EDGE, Face, Label } from '../ui/ui'
import { useGo, useMe, useOpenThread } from '../workspace'
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

/** The Feed's rows: a card that waits, Vivid's work, and the one block of what is handled. */
type Row = Data.TaggedEnum<{
  Computer: { readonly waiting: DeviceWaiting }
  Waiting: { readonly item: feed.Waiting }
  Working: { readonly item: feed.Working }
  Handled: { readonly items: ReadonlyArray<feed.Settled> }
}>
const Row = Data.taggedEnum<Row>()

/**
 * The Feed on the phone: the same Feed as the web (`apps/web/src/screen/Feed.tsx`), laid out for
 * one column, as the accepted design's phone frames are (13 October 2026, v8 then v9). The head is
 * the date, the greeting and Vivid's face with the standing line; then each card that waits on the
 * Person, Vivid's work, and what is handled; the composer stays at the foot.
 *
 * A card that waits counts as looked at once all of it has been on screen (`markSeen`, from the
 * list's own viewability event). Pressing a card's answer folds it out of the list while the
 * words go to its Thread, and Vivid's face is pleased for a moment.
 */
export function Feed() {
  const me = useMe()
  const data = useLiveData()
  const go = useGo()
  const openThread = useOpenThread()
  const start = useStart()
  // The composer's height: it floats over the foot of the list, which keeps that much clear.
  const [foot, setFoot] = useState(0)
  const state = useLive(data.live.feed)
  const items = LiveState.$is('Ready')(state) ? state.value.items : []
  const view = feed.feedView(items, useLiveValue(data.live.devices))
  const pleased = usePleased((now) => now.pleased)
  const presses = usePresses((now) => now.presses)
  const [hello] = useState(() => greetingAt(new Date().getHours()))
  // The moment the page was opened, which every time on it is said against; read once.
  const [now] = useState(() => Date.now())
  const date = today.format(now)
  const first = me.person.name.trim().split(/\s+/u, 1).join('')

  // A card that a press has folded leaves the list until Vivid posts again.
  const shown = view.waiting.filter(
    (item) => !feed.folds(item, Option.fromUndefinedOr(presses.get(item.card))),
  )
  // A card a press has folded no longer waits on the Person, so it leaves the count with it.
  const standing = feed.standingOf(Option.toArray(view.computer).length + shown.length)
  // Every waiting card stays in the list, a folded one drawn as nothing (`Waiting`), so what the
  // Person chose in its display is still there if the send fails and the card comes back.
  const rows: ReadonlyArray<Row> = [
    ...Option.toArray(view.computer).map((waiting) => Row.Computer({ waiting })),
    ...view.waiting.map((item) => Row.Waiting({ item })),
    ...view.working.map((item) => Row.Working({ item })),
    ...(view.settled.length > 0 ? [Row.Handled({ items: view.settled })] : []),
  ]

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

  const head = (
    <Head
      date={date}
      greeting={first.length === 0 ? `${hello}.` : `${hello}, ${first}.`}
      mood={LOOK[feed.feedFace(view, pleased)]}
      standing={standing}
    />
  )

  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={Row.$match({
          Computer: ({ waiting }) => `computer:${waiting.device.id}`,
          // A new post is a new row: the display's own choices start again with it.
          Waiting: ({ item }) => `${item.card}:${feed.revisionOf(item)}`,
          Working: ({ item }) => item.card,
          Handled: () => 'handled',
        })}
        ListHeaderComponent={head}
        // Clear of the glass bar and its menu button, as every other page under it is; without
        // it the date and the greeting stood under the menu button.
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 + foot, gap: 12 }}
        scrollIndicatorInsets={{ bottom: foot }}
        viewabilityConfigCallbackPairs={looked}
        renderItem={({ item: row }) =>
          Row.$match(row, {
            Computer: ({ waiting }) => <Computer waiting={waiting} now={now} />,
            Handled: ({ items: settled }) => (
              <Handled items={settled} now={now} onOpen={(thread) => openThread(thread)} />
            ),
            Working: ({ item }) => (
              <Card
                card={item.card}
                from={item.from}
                at={item.since}
                post={Option.fromNullOr(item.post)}
                ask={{ title: item.from, words: 'Vivid is working on this now.' }}
                bar={Option.none()}
                now={now}
                remember={Option.none()}
                onOpen={() => openThread(item.thread)}
              />
            ),
            Waiting: ({ item }) => (
              <Waiting
                item={item}
                press={Option.fromUndefinedOr(presses.get(item.card))}
                now={now}
                onAnswer={(words) => answer(data, item, words)}
                onDone={() => close(data, item)}
                onOpen={() => openThread(item.thread)}
              />
            ),
          })
        }
      />
      {/* Over the foot of the list, as a Thread's composer is: nothing behind it but the cards.
          The composer keeps the home indicator's inset itself. */}
      <View
        pointerEvents="box-none"
        onLayout={(event) => setFoot(event.nativeEvent.layout.height)}
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
    </Screen>
  )
}

/** The head of the Feed: the date, the greeting beside Vivid's face, and the standing line. */
function Head({
  date,
  greeting,
  mood,
  standing,
}: {
  date: string
  greeting: string
  mood: (typeof LOOK)[keyof typeof LOOK]
  standing: ReturnType<typeof feed.standingOf>
}) {
  return (
    <View style={{ paddingTop: 24, paddingBottom: 16 }}>
      <Label size="label" tone="ink-3">
        {date}
      </Label>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 8 }}>
        <Label accessibilityRole="header" size="opening" style={{ flex: 1 }}>
          {greeting}
        </Label>
        <Face size={56} mood={mood} />
      </View>
      <Label size="body" tone="ink-2" style={{ marginTop: 10 }}>
        <Label size="body" style={{ fontWeight: '600' }}>
          {standing.lead}
        </Label>
        {standing.rest.length > 0 ? ` ${standing.rest}` : ''}
      </Label>
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
  press,
  now,
  onAnswer,
  onDone,
  onOpen,
}: {
  item: feed.Waiting
  press: Option.Option<feed.Press>
  now: number
  onAnswer: (words: string) => void
  onDone: () => void
  onOpen: () => void
}) {
  const post = Option.fromNullOr(item.post)
  // Folded by a press on this post: it takes no room and no touch, but stays mounted, so its
  // display keeps what the Person chose for when a failed send brings it back.
  const folded = feed.folds(item, press)
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
          That did not reach Vivid. Press it again.
        </Label>
      )}
      <Card
        card={item.card}
        from={item.from}
        at={item.at}
        post={post}
        ask={{ title: item.from, words: feed.askedWords(item) }}
        bar={Option.map(post, (made) => (chosen: feed.Chosen) => (
          <Answers
            actions={made.actions}
            chosen={chosen}
            // Only a send for this very post holds its buttons: an older post's send still on its
            // way does not stop the Person answering the one now shown.
            held={Option.exists(
              press,
              (held) => feed.Press.$is('Sending')(held) && held.revision === feed.revisionOf(item),
            )}
            onSay={onAnswer}
            onDone={onDone}
          />
        ))}
        now={now}
        remember={Option.some({ post: feed.revisionOf(item) })}
        onOpen={onOpen}
      />
    </Animated.View>
  )
}

/**
 * One card: where it is from and when, its title (which opens the background Thread), what Vivid
 * says, the thing itself in a band of the accent's soft tint running to the card's edges, and the
 * card's own buttons. Buttons inside the display are inert here; what the Person picks inside it
 * still works and the buttons' words follow it (`feed.fill`).
 */
function Card({
  card,
  from,
  at,
  post,
  ask,
  bar,
  now,
  remember,
  onOpen,
}: {
  /** The card whose post this is; its display's programs run only as that post wrote them. */
  card: FeedCardId
  from: string
  at: number
  post: Option.Option<FeedPost>
  ask: { readonly title: string; readonly words: string }
  bar: Option.Option<(chosen: feed.Chosen) => ReactNode>
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
  const [chosen, setChosen] = useState<feed.Chosen>(start)
  const choose = (next: feed.Chosen) => {
    Option.map(remember, ({ post }) => remembered.set(card, { post, chosen: next }))
    setChosen(next)
  }
  const title = Option.match(post, { onNone: () => ask.title, onSome: (made) => made.title })
  const words = Option.match(post, { onNone: () => ask.words, onSome: (made) => made.words })
  const display = Option.flatMap(post, (made) => Option.fromNullOr(made.display))
  return (
    <View
      style={{
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: EDGE,
        borderColor: c['line-2'],
        backgroundColor: c.card,
        padding: 16,
        overflow: 'hidden',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 22 }}>
        <Label size="label" tone="ink-2" numberOfLines={1} style={{ flex: 1 }}>
          {from}
        </Label>
        <Label size="label" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
          {when(at, now)}
        </Label>
      </View>
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Opens the conversation"
        onPress={onOpen}
        style={({ pressed }) => ({ marginTop: 12, opacity: pressed ? 0.6 : 1 })}
      >
        <Label size="headline" textBreakStrategy="balanced">
          {title}
        </Label>
      </Pressable>
      <Label size="footnote" tone="ink-2" style={{ marginTop: 4, fontWeight: '400' }}>
        {words}
      </Label>
      {Option.isSome(display) && (
        <View
          style={{
            marginHorizontal: -16,
            marginTop: 14,
            marginBottom: Option.isNone(bar) ? -16 : 0,
            paddingHorizontal: 16,
            paddingBottom: 16,
            backgroundColor: c['accent-soft'],
          }}
        >
          <Display
            source={DisplaySource.cases.FeedPost.make({ post: card })}
            text={display.value}
            arriving={false}
            live={false}
            onSay={() => undefined}
            onState={choose}
            initial={start}
          />
        </View>
      )}
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
          {bar.value(chosen)}
        </View>
      )}
    </View>
  )
}

/**
 * A waiting card's buttons, as Vivid wrote them with the Person's pick laid in: the way out keeps
 * to its words, the answer takes the rest of the width (v9). A card with none gets "Done".
 */
function Answers({
  actions,
  chosen,
  held,
  onSay,
  onDone,
}: {
  actions: FeedPost['actions']
  chosen: feed.Chosen
  held: boolean
  onSay: (words: string) => void
  onDone: () => void
}) {
  if (actions.length === 0)
    return <Choice words="Done" primary={false} held={held} onPress={onDone} />
  const said = actions.map((action) => feed.fill(action, chosen))
  const last = said.length - 1
  return (
    <>
      {said.map((words, place) => (
        <Choice
          // Each button is its place: the way out, then the answer.
          // oxlint-disable-next-line react/no-array-index-key
          key={place}
          words={words}
          primary={place === last}
          held={held}
          onPress={() => onSay(words)}
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

/** What is already handled: lines, not cards, each opening its Thread. */
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
        Handled
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
