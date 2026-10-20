import type { FeedResponse, MeResponse, ThreadId } from '@vivid/contracts'
import { draftPlace, feed, greetingAt, makeWhen, thisReader, workspaceKey } from '@vivid/state'
import { Check } from 'lucide-react'
import { Option } from 'effect'
import { useState } from 'react'
import { answer, close, pressOn, seenWhenShown, usePleased, usePresses } from '../data/feed'
import { live, LiveState, useLive } from '../data/live'
import { startThread } from '../data/threads'
import { useAppearance } from '../data/vivid'
import { Alive } from '../ui/Alive'
import { Card, Answers } from './feed/Card'
import { Composer } from './thread/Composer'

const when = makeWhen(thisReader())

/** Today as the head of the page says it: "Tuesday 20 October". */
const today = new Intl.DateTimeFormat(thisReader().locale, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

/**
 * The Feed: how Vivid brings things to the Person. Vivid works on its own in background Threads
 * and reaches the Person only through cards it posts there (`FeedItem`, `@vivid/contracts`).
 *
 * The page is the accepted design of 13 October 2026 (v8, then v9 for the buttons), in the app's
 * own pieces. The head is the date, the greeting, and the standing line ("2 things need you. The
 * rest is handled."). Under it, what waits on the Person, one card each. Beside it on a wide
 * screen (under it on a narrow one) is Vivid's own column: its living face, what it is working on,
 * and what is handled. The composer stays at the foot, as on the first screen, because a Feed with
 * no way to start a Thread was rejected ("I can't start a thread from here").
 *
 * Settling a card folds it away where it stood (`motion-fold`) and Vivid's face is pleased for a
 * moment (`usePleased`), so the press is answered on the frame it happened in.
 */
export function Feed({ me, onOpen }: { me: MeResponse; onOpen: (thread: ThreadId) => void }) {
  const state = useLive(live.feed)
  const items = LiveState.$is('Ready')(state) ? state.value.items : []
  return <FeedView me={me} items={items} onOpen={onOpen} />
}

/** The Feed drawn from its items: everything above, with no query of its own. */
export function FeedView({
  me,
  items,
  onOpen,
}: {
  me: MeResponse
  items: (typeof FeedResponse.Type)['items']
  onOpen: (thread: ThreadId) => void
}) {
  const view = feed.feedView(items)
  const pleased = usePleased((now) => now.pleased)
  const { name } = useAppearance()
  // Read once: a greeting that changed while someone was looking at it would be a glitch.
  const [hello] = useState(() => greetingAt(new Date().getHours()))
  // The moment the page was opened, which every time on it is said against; read once.
  const [now] = useState(() => Date.now())
  const date = today.format(now)
  const first = me.person.name.trim().split(/\s+/u)[0]
  // A card a press has folded no longer waits on the Person, so it leaves the count with it.
  const presses = usePresses((now) => now.presses)
  const standing = feed.standingOf(
    view.waiting.filter((item) => !feed.folds(item, Option.fromUndefinedOr(presses.get(item.card))))
      .length,
  )
  const place = draftPlace(me.person.id, {
    workspace: workspaceKey(me.workspace),
    thread: Option.none(),
  })
  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-surface-0">
      <div className="mx-auto grid w-full max-w-270 grid-cols-1 content-start gap-x-12 px-4 pt-12 sm:px-8 lg:grid-cols-5">
        <header className="flex motion-enter items-end justify-between gap-4 lg:col-span-3">
          <div className="min-w-0">
            <p className="text-label text-ink-3">{date}</p>
            <h1 className="mt-2.5 font-display text-display font-strong tracking-display text-balance wrap-break-word text-ink">
              {first === undefined || first.length === 0 ? `${hello}.` : `${hello}, ${first}.`}
            </h1>
            <p className="mt-3 text-dialog text-pretty text-ink-2">
              <b className="font-title text-ink">{standing.lead}</b> {standing.rest}
            </p>
          </div>
          {/* On a narrow screen Vivid's face heads the page; on a wide one it heads its own column. */}
          <Alive state={feed.feedFace(view, pleased)} size={56} className="shrink-0 lg:hidden" />
        </header>

        <div className="hidden items-center gap-3 self-end lg:col-span-2 lg:col-start-4 lg:row-start-1 lg:flex">
          <Alive state={feed.feedFace(view, pleased)} size={56} />
          <p className="text-label font-title text-ink-3">
            {view.working.length > 0 ? 'Vivid is working on' : 'Vivid is here'}
          </p>
        </div>

        <div className="mt-6 flex min-w-0 flex-col lg:col-span-3">
          {view.waiting.map((item) => (
            <Waiting
              // A new post is a new card: the display's own choices start again with it.
              key={`${item.card}:${feed.revisionOf(item)}`}
              item={item}
              now={now}
              onOpen={() => onOpen(item.thread)}
            />
          ))}
        </div>

        <aside className="mt-6 flex min-w-0 flex-col gap-3 lg:sticky lg:top-6 lg:col-span-2 lg:col-start-4 lg:row-start-2 lg:self-start">
          {view.working.map((item) => (
            <Card
              key={item.card}
              from={item.from}
              at={item.since}
              post={Option.fromNullOr(item.post)}
              ask={{ title: item.from, words: 'Vivid is working on this now.' }}
              bar={Option.none()}
              now={now}
              onOpen={() => onOpen(item.thread)}
            />
          ))}
          <Handled settled={view.settled} now={now} onOpen={onOpen} />
        </aside>
      </div>
      {/* The composer rests at the foot of the column the cards are in, and what scrolls under it
          fades into the page rather than being cut by its edge. */}
      <div className="sticky bottom-0 mx-auto mt-auto w-full max-w-270 bg-linear-to-t from-surface-0 from-60% to-transparent px-4 pt-8 pb-6 sm:px-8">
        <div className="lg:w-3/5 lg:pe-7">
          <Composer
            place={place}
            placeholder={`Message ${name}`}
            working={false}
            onSend={(text) => startThread(text)}
            onStop={() => undefined}
          />
        </div>
      </div>
    </section>
  )
}

/**
 * A card that waits on the Person, in its slot. The slot folds away while a press on it is on
 * its way or sent (`feed.folds`), and comes back when Vivid posts again. A card not yet looked
 * at is watched into view (`seenWhenShown`).
 */
function Waiting({ item, now, onOpen }: { item: feed.Waiting; now: number; onOpen: () => void }) {
  const press = usePresses(pressOn(item.card))
  const folded = feed.folds(item, press)
  const post = Option.fromNullOr(item.post)
  const title = Option.match(post, { onNone: () => item.from, onSome: (made) => made.title })
  return (
    <div data-folded={folded ? '' : undefined} inert={folded} className="motion-fold">
      <div className="pb-3">
        {feed.failed(item, press) && (
          <p className="pb-2 text-label text-danger">That did not reach Vivid. Press it again.</p>
        )}
        <Card
          from={item.from}
          at={item.at}
          post={post}
          ask={{ title: item.from, words: feed.askedWords(item) }}
          seen={item.seen ? undefined : seenWhenShown(item.card)}
          bar={Option.map(post, (made) => (chosen: feed.Chosen) => (
            <Answers
              actions={made.actions}
              chosen={chosen}
              held={folded}
              onSay={(words) => answer(item, words)}
              onDone={() => close(item, title)}
            />
          ))}
          now={now}
          onOpen={onOpen}
        />
      </div>
    </div>
  )
}

/** What is already handled: lines, not cards, each opening its Thread. */
function Handled({
  settled,
  now,
  onOpen,
}: {
  settled: ReadonlyArray<feed.Settled>
  now: number
  onOpen: (thread: ThreadId) => void
}) {
  if (settled.length === 0) return null
  return (
    <section className="mt-4">
      <h2 className="px-1 pb-1 text-label font-title text-ink-3">Handled</h2>
      <ul className="flex flex-col">
        {settled.map((item) => (
          <li key={item.card} className="border-t border-line-1 first:border-t-0">
            <button
              type="button"
              onClick={() => onOpen(item.thread)}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-row px-1 py-3 text-start text-body text-ink-2 transition-colors duration-150 hover:bg-wash-hover hover:text-ink"
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
                <Check className="size-3" strokeWidth={3} />
              </span>
              <span className="min-w-0 flex-1 truncate">
                {Option.match(Option.fromNullOr(item.post), {
                  onNone: () => item.from,
                  onSome: (made) => made.title,
                })}
              </span>
              <time className="shrink-0 text-label text-ink-3 tabular-nums">
                {when(item.at, now)}
              </time>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
