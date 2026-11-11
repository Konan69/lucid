import type { Approval, FeedResponse, MeResponse, ThreadId } from '@vivid/contracts'
import {
  allowing,
  draftPlace,
  feed,
  makeWhen,
  owed,
  thisReader,
  todos,
  workspaceKey,
  type DeviceList,
} from '@vivid/state'
import { Check } from 'lucide-react'
import { Option } from 'effect'
import { useState } from 'react'
import { useApprovalDecision } from '../data/approvals'
import {
  answer,
  close,
  pressOn,
  resume,
  seenWhenShown,
  useResumed,
  usePleased,
  usePresses,
} from '../data/feed'
import { useStandings } from '../data/owed'
import { live, LiveState, useLive, useLiveValue } from '../data/live'
import { startThread } from '../data/threads'
import { useAppearance } from '../data/vivid'
import { Alive } from '../ui/Alive'
import { Card } from './feed/Card'
import { Decide } from './feed/Decide'
import { Owed } from './feed/Owed'
import { Todos } from './feed/Todos'
import { Computer } from './thread/Device'
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
 * and reaches the Person through cards it posts there (`FeedItem`, `@vivid/contracts`), and it
 * keeps the list of who owes the Person what (`Owed`), which it chases.
 *
 * The page is the "tide table" direction of 27 October 2026. The head is the date beside Vivid's
 * living face and one sentence about what the Person is waiting on ("5 people owe you. Adaeze is
 * a day late."), or, with nothing owed, the Feed's standing line. Then the waiting-on list, the
 * page's hero (`feed/Owed.tsx`), and under it the Person's own to-do list (`feed/Todos.tsx`). Beside it on a wide screen (under it on a narrow one) is what
 * needs the Person, one card each, Vivid's work in hand, and what is handled. The composer stays at
 * the foot, because a Feed with no way to start a Thread was rejected ("I can't start a thread
 * from here").
 *
 * Settling a card or closing a record folds it away where it stood (`motion-fold`) and Vivid's
 * face is pleased for a moment (`usePleased`), so the press is answered on the frame it happened in.
 */
export function Feed({ me, onOpen }: { me: MeResponse; onOpen: (thread: ThreadId) => void }) {
  const state = useLive(live.feed)
  const items = LiveState.$is('Ready')(state) ? state.value.items : []
  const devices = useLiveValue(live.devices)
  const owedList = useLiveValue(live.owed)
  const todoList = useLiveValue(live.todos)
  const inbox = useLiveValue(live.inbox)
  return (
    <FeedView
      me={me}
      items={items}
      approvals={Option.match(inbox, { onNone: () => [], onSome: (held) => held.approvals })}
      waiting={Option.match(owedList, {
        onNone: () => [],
        onSome: (list) => owed.waitingOf(list.owed),
      })}
      zone={Option.map(useLiveValue(live.settings), (settings) => settings.timezone)}
      toDo={Option.match(todoList, {
        onNone: () => [],
        onSome: (list) => todos.openOf(list.todos),
      })}
      devices={devices}
      onOpen={onOpen}
    />
  )
}

/** The Feed drawn from its items, the waiting-on list and the to-do list: everything above, with no query of its own. */
export function FeedView({
  me,
  items,
  approvals,
  waiting,
  zone,
  toDo,
  devices,
  onOpen,
}: {
  me: MeResponse
  items: (typeof FeedResponse.Type)['items']
  /** Every Approval waiting on this Person (`WatchInbox`), so a card can be decided where it is. */
  approvals: ReadonlyArray<Approval>
  waiting: ReadonlyArray<owed.Waiting>
  /** The Person's own zone: deadlines and due dates are days on their calendar, so rows wait for it. */
  zone: Option.Option<string>
  toDo: ReadonlyArray<todos.Open>
  devices: Option.Option<DeviceList>
  onOpen: (thread: ThreadId) => void
}) {
  const view = feed.feedView(items, devices)
  const pleased = usePleased((face) => face.pleased)
  const { name } = useAppearance()
  // The moment the page was opened, which every time on it is said against; read once.
  const [now] = useState(() => Date.now())
  const date = today.format(now)
  // A card a press has folded no longer waits on the Person, so it leaves the count with it.
  const presses = usePresses((held) => held.presses)
  const askedOf = (item: feed.Waiting) => feed.approvalOf(item, approvals)
  // A record a press has closed is no longer owed, so it leaves the head's sentence with it.
  const standings = useStandings()
  const open = waiting.filter((record) => standings.get(record.id) !== 'folded')
  const needs =
    Option.toArray(view.computer).length +
    view.waiting.filter((item) => !feed.folds(item, Option.fromUndefinedOr(presses.get(item.card))))
      .length
  const standing = feed.standingOf(needs)
  const head = Option.flatMap(zone, (tz) => owed.headOf(open, owed.owedWordsIn(tz).timing, now))
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
            {/* The one line the page opens with: what the Person is waiting on, or, with nothing
                owed, what needs them. Never a greeting. */}
            <h1 className="mt-2.5 font-display text-display font-strong tracking-display text-balance wrap-break-word text-ink">
              {Option.match(head, { onNone: () => standing.lead, onSome: ({ lead }) => lead })}
            </h1>
            <p className="mt-3 text-dialog text-pretty text-ink-2">
              <Standing head={head} standing={standing} />
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

        <div className="mt-8 flex min-w-0 flex-col gap-8 lg:col-span-3">
          <Owed waiting={waiting} zone={zone} now={now} onOpen={onOpen} />
          {toDo.length > 0 && <Todos open={toDo} zone={zone} now={now} onOpen={onOpen} />}
          {(Option.isSome(view.computer) || view.waiting.length > 0) && (
            <section aria-labelledby="needs-heading" className="flex flex-col">
              <h2 id="needs-heading" className="px-1 pb-2 text-label font-title text-ink-3">
                Needs you
              </h2>
              {Option.toArray(view.computer).map((asking) => (
                <div key={asking.device.id} className="pb-3">
                  <Computer waiting={asking} now={now} />
                </div>
              ))}
              {view.waiting.map((item) => (
                <Waiting
                  // A new post is a new card: the display's own choices start again with it.
                  key={`${item.card}:${feed.revisionOf(item)}`}
                  item={item}
                  asked={askedOf(item)}
                  now={now}
                  onOpen={() =>
                    feed.answeredInPlace(item) ? onOpen(item.thread) : resume(item.thread)
                  }
                />
              ))}
            </section>
          )}
        </div>

        <aside className="mt-8 flex min-w-0 flex-col gap-3 pb-6 lg:sticky lg:top-6 lg:col-span-2 lg:col-start-4 lg:row-start-2 lg:self-start">
          {view.working.map((item) => (
            <Working key={item.card} item={item} now={now} />
          ))}
          <Handled settled={view.settled} now={now} onOpen={resume} />
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
 * The line under the head's sentence. With something owed: the record that matters now, bold, then
 * what needs the Person; or, with none of them urgent, the Feed's standing line. With nothing
 * owed the head already said the standing, so this says how something comes to be owed.
 */
function Standing({
  head,
  standing,
}: {
  head: Option.Option<owed.Head>
  standing: ReturnType<typeof feed.standingOf>
}) {
  if (Option.isNone(head)) return EMPTY
  return Option.match(head.value.rest, {
    onSome: (rest) => (
      <>
        <b className="font-title text-ink">{rest}</b> {standing.lead}
      </>
    ),
    onNone: () => (
      <>
        <b className="font-title text-ink">{standing.lead}</b> {standing.rest}
      </>
    ),
  })
}

/** What the head says under the standing line when nobody owes the Person anything. */
const EMPTY = 'When someone promises you something, tell Vivid. It keeps track and chases it.'

/**
 * A card that waits on the Person, in its slot. The slot folds away while a press on it is on
 * its way or sent (`feed.folds`), and comes back when Vivid posts again. A card not yet looked
 * at is watched into view (`seenWhenShown`).
 */
function Waiting({
  item,
  asked,
  now,
  onOpen,
}: {
  item: feed.Waiting
  /** The Approval the work stopped on that this Person decides, if it did (`feed.approvalOf`). */
  asked: Option.Option<Approval>
  now: number
  onOpen: () => void
}) {
  const press = usePresses(pressOn(item.card))
  const deciding = useApprovalDecision()
  // Decided here, the Approval is never pending again: the card folds until the Feed moves on.
  const folded =
    feed.folds(item, press) ||
    Option.exists(asked, (approval) => allowing.sentOn(deciding, approval.id))
  const post = Option.fromNullOr(item.post)
  const title = Option.match(post, { onNone: () => item.from, onSome: (made) => made.title })
  return (
    <div data-folded={folded ? '' : undefined} inert={folded} className="motion-fold">
      <div className="pb-3">
        {feed.failed(item, press) && (
          <p className="pb-2 text-label text-danger">Not sent. Try again.</p>
        )}
        <Unstarted work={item.thread} />
        <Card
          card={item.card}
          at={item.at}
          post={post}
          ask={{ title: item.from, words: feed.askedWords(item) }}
          asked={Option.map(asked, (approval) => (
            <Decide approval={approval} room="card" />
          ))}
          seen={item.seen ? undefined : seenWhenShown(item.card)}
          reply={Option.some({
            held: folded,
            onSay: (words: string) => answer(item, words),
            onDone: () => close(item, title),
          })}
          now={now}
          onOpen={onOpen}
        />
      </div>
    </div>
  )
}

/** Work Vivid is doing now; a press starts a new Conversation about it. */
function Working({ item, now }: { item: feed.Working; now: number }) {
  return (
    <div>
      <Unstarted work={item.thread} />
      <Card
        card={item.card}
        at={item.since}
        post={Option.fromNullOr(item.post)}
        ask={{ title: item.from, words: 'Vivid is working on this now.' }}
        asked={Option.none()}
        reply={Option.none()}
        now={now}
        onOpen={() => resume(item.thread)}
      />
    </div>
  )
}

/**
 * Said over an item whose press did not start its new Conversation; pressing it again tries the
 * same one (`feed.Resuming`).
 */
function Unstarted({ work }: { work: ThreadId }) {
  if (useResumed(work) !== 'unstarted') return null
  return <p className="pb-2 text-label text-danger">Couldn’t start a chat about this. Try again.</p>
}

/** What is already handled: lines, not cards, each starting a new Conversation about its work. */
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
