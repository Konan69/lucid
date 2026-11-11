import { DisplaySource, FeedPost, type FeedAction, type FeedCardId } from '@vivid/contracts'
import { makeWhen, thisReader } from '@vivid/state'
import { Option } from 'effect'
import type { ReactNode, Ref } from 'react'
import { Display } from '../../parts/Display'
import { Button } from '../../ui/button'

const when = makeWhen(thisReader())

/** What on a card answers a press itself, so the card's own press leaves it alone. */
const OWN = 'a, button, input, select, textarea, label, summary, [role="button"], [contenteditable]'

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
 * One card of the Feed: the face of one background Thread. Under a quiet row of its title (which
 * opens the Thread) and when, the card is one of the post's two cases (`FeedPost`):
 *
 * - `Drawn`: Vivid's display is the whole card, drawn by the renderer a reply uses, and its own
 *   Buttons answer in the Thread as a reply's do. Nothing of ours is written above or under it
 *   (29 October 2026: "why does it look like we're containing the model?"); the row's "Done" puts
 *   it away when the drawing has no way out of its own.
 * - `Said`: nothing to draw, so a sentence or two under the title, and the card's buttons, the way out
 *   first and the answer last (v9 of the 13 October design: "yh buttons are better").
 *
 * With no post, the work's own state in words stands as a said card with no buttons, unless the
 * work stopped on an Approval this Person decides: then the card body is that Approval to decide
 * (`asked`, `Decide.tsx`), a send drawn as its draft, under a post when there is one.
 */
export function Card({
  card,
  at,
  post,
  ask,
  asked,
  reply,
  seen,
  now,
  onOpen,
}: {
  /** The card whose post this is; its display's programs run only as that post wrote them. */
  card: FeedCardId
  /** When it was posted or began, epoch milliseconds. */
  at: number
  post: Option.Option<FeedPost>
  /** What the card says when Vivid posted nothing: the work's own state in words. */
  ask: { readonly title: string; readonly words: string }
  /** The Approval the work stopped on, to decide here; it stands in for `ask.words`. */
  asked: Option.Option<ReactNode>
  reply: Option.Option<Reply>
  /** Watches the card into view, for a card not yet looked at. */
  seen?: Ref<HTMLElement>
  /** When the page was opened: times are said against it. */
  now: number
  onOpen: () => void
}) {
  const title = Option.match(post, { onNone: () => ask.title, onSome: (made) => made.title })
  const said = (words: string, actions: Option.Option<ReadonlyArray<FeedAction>>) => (
    <Said words={words} actions={actions} reply={reply} />
  )
  return (
    // A press anywhere on the card does what its title does. The title stays the one control a
    // keyboard or screen reader uses; a press on anything of its own (a button, a link, a field
    // of a drawn form) or one that ends a text selection stays with that.
    <article
      ref={seen}
      aria-label={title}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest(OWN) !== null) return
        const selection = document.getSelection()
        if (selection !== null && !selection.isCollapsed) return
        onOpen()
      }}
      className="group cursor-pointer overflow-hidden rounded-composer bg-surface-3 p-4 edge"
    >
      {/* What the card is about, which opens its Thread, then when, always at the trailing edge.
          The post's own title says it once; the drawing and the words under it do not repeat it
          (29 October 2026: "repeating", then "date on the right always", "you lost context"). */}
      <div className="flex min-h-5.5 items-center gap-2 text-label">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 cursor-pointer truncate rounded-row text-start font-strong text-ink-2 decoration-ink-4 underline-offset-4 group-hover:text-ink group-hover:underline focus-visible:outline-offset-2"
        >
          {title}
        </button>
        <time className="ms-auto shrink-0 text-ink-3 tabular-nums">{when(at, now)}</time>
        {/* Every waiting item can be put away: a drawn card, and an Approval or a question Vivid
            posted no card for, have no button of their own that does it. */}
        {(Option.isNone(post) || Option.exists(post, FeedPost.guards.Drawn)) &&
          Option.isSome(reply) && (
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
      {/* Where the card came from, in Vivid's words, under the title: Muse's rule that every
          unasked item says where it came from. A card from before it was kept says nothing. */}
      {Option.match(
        Option.flatMap(post, (made) => Option.fromNullOr(made.from)),
        {
          onNone: () => null,
          onSome: (from) => <p className="mt-0.5 truncate text-label text-ink-3">From {from}</p>,
        },
      )}
      {Option.match(post, {
        onNone: () => Option.getOrElse(asked, () => said(ask.words, Option.none())),
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
      {Option.isSome(post) && Option.getOrNull(asked)}
    </article>
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
      <p className="mt-2 text-title text-pretty text-ink">{words}</p>
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
