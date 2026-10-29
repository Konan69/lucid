import { DisplaySource, FeedPost, type FeedAction, type FeedCardId } from '@vivid/contracts'
import { makeWhen, thisReader } from '@vivid/state'
import { Option } from 'effect'
import type { Ref } from 'react'
import { Display } from '../../parts/Display'
import { Button } from '../../ui/button'

const when = makeWhen(thisReader())

/** How the Person answers a waiting card. A card Vivid is still working on takes no answer. */
export interface Reply {
  /** A press is on its way: nothing more can be pressed. */
  readonly held: boolean
  /** Says these words in the card's Thread, as the Person. */
  readonly onSay: (words: string) => void
  /** Puts the card away without an answer. */
  readonly onDone: () => void
}

/**
 * One card of the Feed: the face of one background Thread. Under a quiet row of where it is from
 * (which opens the Thread) and when, the card is one of the post's two cases (`FeedPost`):
 *
 * - `Drawn`: Vivid's display is the whole card, drawn by the renderer a reply uses, and its own
 *   Buttons answer in the Thread as a reply's do. Nothing of ours is written above or under it
 *   (29 October 2026: "why does it look like we're containing the model?"); the row's "Done" puts
 *   it away when the drawing has no way out of its own.
 * - `Said`: nothing to draw, so the title, a sentence or two, and the card's buttons, the way out
 *   first and the answer last (v9 of the 13 October design: "yh buttons are better").
 *
 * With no post, the work's own state in words stands as a said card with no buttons.
 */
export function Card({
  card,
  from,
  at,
  post,
  ask,
  reply,
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
  reply: Option.Option<Reply>
  /** Watches the card into view, for a card not yet looked at. */
  seen?: Ref<HTMLElement>
  /** When the page was opened: times are said against it. */
  now: number
  onOpen: () => void
}) {
  const title = Option.match(post, { onNone: () => ask.title, onSome: (made) => made.title })
  const said = (words: string, actions: Option.Option<ReadonlyArray<FeedAction>>) => (
    <Said title={title} words={words} actions={actions} reply={reply} onOpen={onOpen} />
  )
  return (
    <article
      ref={seen}
      aria-label={title}
      className="overflow-hidden rounded-composer bg-surface-3 p-4 edge"
    >
      <div className="flex min-h-5.5 items-center gap-2 text-label text-ink-2">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 cursor-pointer truncate rounded-row text-start decoration-ink-4 underline-offset-4 hover:text-ink hover:underline focus-visible:outline-offset-2"
        >
          {from}
        </button>
        <time className="ms-auto shrink-0 text-ink-3 tabular-nums">{when(at, now)}</time>
        {Option.exists(post, FeedPost.guards.Drawn) && Option.isSome(reply) && (
          <Button
            variant="ghost"
            size="xs"
            className="-me-2"
            disabled={reply.value.held}
            onClick={reply.value.onDone}
          >
            Done
          </Button>
        )}
      </div>
      {Option.match(post, {
        onNone: () => said(ask.words, Option.none()),
        onSome: FeedPost.match({
          Drawn: ({ display }) => (
            <div className="mt-3">
              <Display
                source={DisplaySource.cases.FeedPost.make({ post: card })}
                text={display}
                arriving={false}
                live={Option.exists(reply, ({ held }) => !held)}
                onSay={(words) => Option.map(reply, ({ onSay }) => onSay(words))}
              />
            </div>
          ),
          Said: ({ words, actions }) => said(words, Option.some(actions)),
        }),
      })}
    </article>
  )
}

/**
 * A card with nothing drawn: its title, which opens the Thread, what Vivid says, and on a waiting
 * post its buttons (`Answers`). The work's own state in words, with no post, has no buttons.
 */
function Said({
  title,
  words,
  actions,
  reply,
  onOpen,
}: {
  title: string
  words: string
  /** The post's buttons; none when Vivid posted nothing. */
  actions: Option.Option<ReadonlyArray<FeedAction>>
  reply: Option.Option<Reply>
  onOpen: () => void
}) {
  const bar = Option.zipWith(actions, reply, (labels, answering) => ({ labels, answering }))
  return (
    <>
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
      {Option.isSome(bar) && (
        <footer className="mt-3 flex justify-end gap-2">
          <Answers actions={bar.value.labels} {...bar.value.answering} />
        </footer>
      )}
    </>
  )
}

/**
 * The buttons under a said card, as Vivid wrote them. With one, it is the answer; with two, the
 * first is the way out and the second the answer. A card with none gets a quiet "Done", which
 * closes it.
 */
function Answers({ actions, held, onSay, onDone }: { actions: ReadonlyArray<FeedAction> } & Reply) {
  if (actions.length === 0) {
    return (
      <Button variant="ghost" disabled={held} onClick={onDone}>
        Done
      </Button>
    )
  }
  const last = actions.length - 1
  return (
    <>
      {actions.map((words, place) => (
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
