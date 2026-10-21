import { DisplaySource, type FeedCardId, type FeedPost } from '@vivid/contracts'
import { feed, makeWhen, thisReader } from '@vivid/state'
import { Option } from 'effect'
import { useState, type ReactNode, type Ref } from 'react'
import { Display } from '../../parts/Display'
import { Button } from '../../ui/button'
import { cn } from '../../ui/cn'

const when = makeWhen(thisReader())

/**
 * One card of the Feed: the face of one background Thread. The accepted design (13 October 2026,
 * v8 then v9, `artifacts/feed-design/openui/src/app/feed/feed.tsx`) in the app's own pieces:
 *
 * - a meta row, where it is from and when, quiet;
 * - the title, which opens the background Thread so the whole exchange can be read;
 * - what Vivid says, a sentence or two;
 * - the thing itself, an OpenUI program drawn by the renderer a reply uses, in a band of the
 *   primary's soft tint that runs to the card's edges;
 * - the card's own buttons under it: the way out first, the answer last (v9: "yh buttons are
 *   better"). They are the app's `Button` at its 32 px, right-aligned, as on the rest of the web.
 *
 * Buttons inside the display are inert here (`live={false}`): the decision is the card's bar. What
 * the Person picks inside the display still works, and the bar's words follow it (`feed.fill`).
 */
export function Card({
  card,
  from,
  at,
  post,
  ask,
  bar,
  seen,
  now,
  onOpen,
}: {
  /** The card whose post this is; its display's programs run only as that post wrote them. */
  card: FeedCardId
  /** What brought it: the background Thread's title. */
  from: string
  /** When it was posted or began, epoch milliseconds. */
  at: number
  post: Option.Option<FeedPost>
  /** What the card says when Vivid posted nothing: the work's own state in words. */
  ask: { readonly title: string; readonly words: string }
  /** The card's buttons, given what the Person has chosen in its display. */
  bar: Option.Option<(chosen: feed.Chosen) => ReactNode>
  /** Watches the card into view, for a card not yet looked at. */
  seen?: Ref<HTMLElement>
  /** When the page was opened: times are said against it. */
  now: number
  onOpen: () => void
}) {
  const [chosen, setChosen] = useState<feed.Chosen>({})
  const title = Option.match(post, { onNone: () => ask.title, onSome: (made) => made.title })
  const words = Option.match(post, { onNone: () => ask.words, onSome: (made) => made.words })
  const display = Option.flatMap(post, (made) => Option.fromNullOr(made.display))
  return (
    <article ref={seen} className="overflow-hidden rounded-composer bg-surface-3 p-4 edge">
      <div className="flex min-h-5.5 items-center gap-2 text-label text-ink-2">
        <span className="min-w-0 truncate">{from}</span>
        <time className="ms-auto shrink-0 text-ink-3 tabular-nums">{when(at, now)}</time>
      </div>
      <h2 className="mt-3">
        <button
          type="button"
          onClick={onOpen}
          className="cursor-pointer rounded-row text-start text-section font-strong tracking-tight text-balance text-ink decoration-ink-4 underline-offset-4 hover:underline focus-visible:outline-offset-2"
        >
          {title}
        </button>
      </h2>
      <p className="mt-1 text-title text-pretty text-ink-2">{words}</p>
      {/* The band takes back the card's 16 px each side, so the drawing runs edge to edge; with
          no bar under it, it runs out at the foot too. */}
      {Option.isSome(display) && (
        <div
          className={cn(
            '-mx-4 mt-3.5 bg-primary-soft px-4 pt-0.5 pb-4',
            Option.isNone(bar) && '-mb-4',
          )}
        >
          <Display
            source={DisplaySource.cases.FeedPost.make({ post: card })}
            text={display.value}
            arriving={false}
            live={false}
            onSay={() => undefined}
            onState={setChosen}
          />
        </div>
      )}
      {Option.isSome(bar) && (
        <footer className="mt-3 flex justify-end gap-2">{bar.value(chosen)}</footer>
      )}
    </article>
  )
}

/**
 * The two answers under a waiting card, as Vivid wrote them, with the Person's pick laid into any
 * `$name`. With one, it is the answer; with two, the first is the way out and the second the
 * answer. A card with none gets a quiet "Done", which closes it.
 */
export function Answers({
  actions,
  chosen,
  held,
  onSay,
  onDone,
}: {
  actions: FeedPost['actions']
  chosen: feed.Chosen
  /** A press is on its way: nothing more can be pressed. */
  held: boolean
  onSay: (words: string) => void
  onDone: () => void
}) {
  if (actions.length === 0) {
    return (
      <Button variant="ghost" disabled={held} onClick={onDone}>
        Done
      </Button>
    )
  }
  const said = actions.map((action) => feed.fill(action, chosen))
  const last = said.length - 1
  return (
    <>
      {said.map((words, place) => (
        <Button
          // Each button is its place: the way out, then the answer.
          // oxlint-disable-next-line react/no-array-index-key
          key={place}
          variant={place === last ? 'default' : 'secondary'}
          disabled={held}
          onClick={() => onSay(words)}
        >
          {words}
        </Button>
      ))}
    </>
  )
}
