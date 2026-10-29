import type { FlueConversationMessage } from '@flue/react'
import {
  DisplaySource,
  InputRequestId,
  InputRequestState,
  textOf,
  type Approval,
  type InputRequest,
  type PersonId,
  type Run,
  type ThreadId,
} from '@vivid/contracts'
import {
  asking,
  makeFullWhen,
  makeWhen,
  offeredReplies,
  Source,
  sourceOf,
  speakerOfTurn,
  stretches,
  thisReader,
} from '@vivid/state'
import { Data, Option, Schema } from 'effect'
import { AlarmClock, Check, Copy as CopyIcon } from 'lucide-react'
import { memo, useState } from 'react'
import { carryOn } from '../../data/threads'
import { Display } from '../../parts/Display'
import { PersonAvatar } from '../../ui/Person'
import { cn } from '../../ui/cn'
import { Alive } from '../../ui/Alive'
import { Face } from '../../ui/Face'
import { Markdown } from '../../ui/Markdown'
import { useRevealed } from '../../ui/reveal'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { approvalById, AskedFirst, cardFor, ConnectionCard, requestById } from './Cards'
import { Asked } from './Question'
import { Replies } from './Replies'
import { stepIn, type ToolPart } from './Doing'

const Metadata = Schema.Struct({
  finishedAt: Schema.optionalKey(Schema.Finite),
  startedAt: Schema.optionalKey(Schema.Finite),
})
const decodeMetadata = Schema.decodeUnknownOption(Metadata)

/** What the Thread carries beside its messages, which the cards and attributions are drawn from. */
export interface ThreadContext {
  readonly thread: ThreadId
  readonly me: PersonId
  readonly shared: boolean
  readonly runs: ReadonlyArray<Run>
  readonly approvals: ReadonlyArray<Approval>
  readonly requests: ReadonlyArray<InputRequest>
}

const reader = thisReader()
const when = makeWhen(reader)
const fullWhen = makeFullWhen(reader)

/** When a message was finished, or failing that begun, where the conversation stamps it. */
const momentOf = (message: FlueConversationMessage): Option.Option<number> =>
  Option.flatMap(decodeMetadata(message.metadata), (metadata) =>
    Option.orElse(Option.fromUndefinedOr(metadata.finishedAt), () =>
      Option.fromUndefinedOr(metadata.startedAt),
    ),
  )

/**
 * When a message was finished, when Vivid said so; an unstamped message simply shows no time. It
 * is said against today (only the time today, "Yesterday", a date before that), with the whole
 * date and time on hover for when that is not enough.
 */
function timeOf(message: FlueConversationMessage) {
  return Option.map(momentOf(message), (moment) => ({
    said: when(moment, Date.now()),
    full: fullWhen(moment),
  }))
}

/** Reads a request's identifier from a signal's attribute, which arrives as plain text. */
const decodeRequest = Schema.decodeUnknownOption(InputRequestId)

/** The request a message is the delivered answer to, when it is that signal. */
function answeredBy(message: FlueConversationMessage): Option.Option<InputRequestId> {
  const signal = message.signal
  if (signal === undefined || signal.tagName !== 'answer' || signal.attributes === undefined) {
    return Option.none()
  }
  return decodeRequest(signal.attributes.request)
}

/** What each message came to, kept against the message itself (`spokenOf`). */
const spoken = new WeakMap<FlueConversationMessage, asking.Spoken>()

/**
 * One message of the conversation as placing answers needs it (`asking.linesOf`, `@vivid/state`):
 * the requests it raised, when it is a reply of Vivid's that asked (`cardFor`); the request it is
 * the delivered answer to, when it is that signal (the server sends an answer to Vivid as an
 * `answer` signal whose `request` attribute names it, `apps/server/src/inputs/store.ts`); and
 * when it was said, where the conversation stamps it.
 *
 * It is read once for each message object. A Thread asks for every message again at each
 * streamed token, and reading one decodes its tool results; Flue hands back the same object for
 * a message that did not change, so only the reply being written is read again.
 */
export function spokenOf(message: FlueConversationMessage): asking.Spoken {
  const known = spoken.get(message)
  if (known !== undefined) return known
  const read: asking.Spoken = {
    key: message.id,
    asked: message.parts.flatMap((part) => {
      if (part.type !== 'dynamic-tool' || part.state !== 'output-available') return []
      const card = cardFor(part.output)
      return Option.isSome(card) && card.value.kind === 'input' ? [card.value.id] : []
    }),
    answers: answeredBy(message),
    at: momentOf(message),
  }
  spoken.set(message, read)
  return read
}

/**
 * A Vivid message with nothing a Person can read in it: no words, no step, no card. The runtime
 * writes one when a model call ends without producing anything. The Run's own state says what
 * happened and is drawn in its place, so the empty shell (a face and a time beside nothing) is not.
 */
export const isBlank = (message: FlueConversationMessage) =>
  message.role === 'assistant' &&
  textOf(message).trim().length === 0 &&
  !message.parts.some((part) => part.type === 'dynamic-tool')

/**
 * The fields of a message a row draws from. Flue hands back the same object for a message that
 * did not change, with one exception: a message this page sent is copied on every snapshot to
 * keep the id it was first drawn under (`converge` in `@flue/react` 2.2.2 `dist/index.mjs`,
 * `{ ...message, id: localId }`). The copy is shallow, so its fields are the same values.
 */
const DRAWN = [
  'id',
  'role',
  'parts',
  'signal',
  'settlement',
  'submissionId',
  'metadata',
] as const satisfies ReadonlyArray<keyof FlueConversationMessage>

/** Whether two messages draw the same row: the same object, or a copy with the same fields. */
const sameMessage = (was: FlueConversationMessage, now: FlueConversationMessage) =>
  was === now || DRAWN.every((field) => was[field] === now[field])

interface MessageProps {
  readonly message: FlueConversationMessage
  readonly context: ThreadContext
  /** Whether Vivid is working on this message right now; only the newest can be worked on. */
  readonly working: boolean
  /** Whether this is the newest message in the Thread, the one a Person can still answer. */
  readonly latest: boolean
  /**
   * Whether Flue has settled the submission this reply answers (its `submissionId` is among the
   * conversation's settlements). Neither `latest`, `working` nor a part's streaming state says so:
   * Flue closes every streaming part between steps and folds a delivery written while the reply
   * arrives into the same submission (`appendToolInput` in `@flue/sdk` 2.2.2,
   * `projectConversationUi` in `@flue/runtime` 2.2.2), so the reply can look finished while its
   * submission is not. The server runs a display's program only from a settled reply.
   */
  readonly settled: boolean
  readonly onContinue: (text: string) => void
}

/**
 * One message in a Thread, drawn by who it is from. A Person's words are a bubble (theirs on the
 * right, anyone else's on the left with a face and a name); Vivid's are text with whatever it did
 * and whatever it is asking; a signal that woke Vivid is a quiet line saying why.
 *
 * A row is drawn again only when something it shows changed. Every streamed token is a new list
 * of messages, and each one used to draw every row of the Thread again: 10,535 row renders and
 * 36 long tasks while twenty keys were typed under a reply streaming into a Thread of 300
 * messages (measured in a browser, 10 October 2026), which is what made typing lag in every
 * field on the page. The design is T3 Code's memoised timeline row.
 */
export const Message = memo(function Message({
  message,
  context,
  working,
  latest,
  settled,
  onContinue,
}: MessageProps) {
  if (message.role === 'user') {
    return <Said text={textOf(message)} mine pictures={picturesOf(message)} />
  }
  if (message.role === 'system') return <Signal message={message} context={context} />
  return (
    <FromVivid
      message={message}
      context={context}
      working={working}
      latest={latest}
      settled={settled}
      onContinue={onContinue}
    />
  )
}, sameRow)

/** Whether a row would be drawn the same: `memo`'s test, with the message compared by `sameMessage`. */
function sameRow(was: MessageProps, now: MessageProps) {
  return (
    was.context === now.context &&
    was.working === now.working &&
    was.latest === now.latest &&
    was.settled === now.settled &&
    was.onContinue === now.onContinue &&
    sameMessage(was.message, now.message)
  )
}

/** A Person's words. In a shared Thread everyone else's carry their name and face. */
export function Said({
  text,
  mine,
  pictures,
  unsent = false,
  from,
}: {
  text: string
  mine: boolean
  pictures: ReadonlyArray<{ url: string; name: string }>
  /** Words that did not arrive: drawn as an outline, where a sent message is filled. */
  unsent?: boolean
  from?: { readonly name: string }
}) {
  if (mine) {
    return (
      <div className="flex justify-end">
        {/* The Person's own words are the one filled shape in a Thread: found at a glance. */}
        <div
          className={cn(
            'max-w-bubble rounded-composer rounded-br-sm px-4 py-2.5 text-body',
            unsent
              ? 'text-ink-2 outline-1 -outline-offset-1 outline-line-4 outline-dashed'
              : 'bg-primary text-primary-foreground selection:bg-primary-foreground/30',
          )}
        >
          {pictures.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pictures.map((picture) => (
                <a
                  key={picture.url}
                  href={picture.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block cursor-pointer rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <img
                    src={picture.url}
                    alt={picture.name}
                    className="size-32 rounded-control object-cover picture-edge"
                  />
                </a>
              ))}
            </div>
          )}
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex gap-3">
      {from !== undefined && <PersonAvatar name={from.name} size={24} className="mt-1" />}
      <div className="min-w-0">
        {from !== undefined && (
          <span className="mb-1 block text-meta font-title text-ink-3">{from.name}</span>
        )}
        <div className="max-w-bubble rounded-composer rounded-tl-sm bg-surface-2 px-4 py-2.5 text-body text-ink">
          {pictures.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pictures.map((picture) => (
                <a
                  key={picture.url}
                  href={picture.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block cursor-pointer rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  <img
                    src={picture.url}
                    alt={picture.name}
                    className="size-32 rounded-control object-cover picture-edge"
                  />
                </a>
              ))}
            </div>
          )}
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      </div>
    </div>
  )
}

/** No pictures: an answer is words. One value, so the bubble is not handed a new list each time. */
const NO_PICTURES: ReadonlyArray<{ url: string; name: string }> = []

/**
 * The answers to one request from Vivid, as the bubble of the Person who gave them
 * (`asking.repliedWords`: one line for each question): this Person's own on the right, filled,
 * exactly as a message they typed; somebody else's on the left under their name. A request
 * still waiting, or withdrawn, draws nothing: a reply that withdrew it is already its own
 * message.
 */
export function Replied({ request, me }: { request: InputRequest; me: PersonId }) {
  return InputRequestState.match(request.state, {
    Waiting: () => null,
    Withdrawn: () => null,
    Answered: ({ answers, answeredBy: person }) =>
      person.id === me ? (
        <Said text={asking.repliedWords(answers)} mine pictures={NO_PICTURES} />
      ) : (
        <Said
          text={asking.repliedWords(answers)}
          mine={false}
          pictures={NO_PICTURES}
          from={{ name: person.name }}
        />
      ),
  })
}

/** A message's image files, in conversation order; other files are not shown as pictures. */
function picturesOf(message: FlueConversationMessage) {
  return message.parts.flatMap((part) => {
    if (part.type !== 'file' || !part.mediaType.startsWith('image/') || part.url === undefined) {
      return []
    }
    return [{ url: part.url, name: part.filename ?? '' }]
  })
}

/** The quiet line each wake is drawn as, by why Vivid woke (`Source.Wake` in `@vivid/state`). */
const SIGNAL_LINE = {
  'follow-up': { Icon: AlarmClock, label: 'Time to follow up' },
} as const

/**
 * Something the server or the runtime put in front of Vivid, drawn by where it came from
 * (`sourceOf` in `@vivid/state`, the reading every surface shares). A Person speaking in a shared
 * Thread is drawn as their bubble. A follow-up is a quiet line. An answer that was
 * not finished is said in Vivid's words, not the runtime's. Nothing else is drawn here: an
 * Approval's outcome is told under its own words (`AskedFirst`) and an answer by its own row
 * (`Replied`), and what the runtime says to itself and the model (its instructions were
 * reloaded, its tools changed) is for no Person.
 */
function Signal({
  message,
  context,
}: {
  message: FlueConversationMessage
  context: ThreadContext
}) {
  return Source.$match(sourceOf(message), {
    Failed: () => (
      <div className="rounded-panel bg-surface-2 px-4 py-3 text-label text-ink-3">
        Vivid could not finish that.
      </div>
    ),
    Said: ({ turn, from }) => (
      <Said
        text={textOf(message)}
        pictures={[]}
        // Whose turn it was comes from the Thread's Runs; the conversation holds no identifier.
        mine={Option.exists(
          speakerOfTurn(context.runs, turn),
          (speaker) => speaker.id === context.me,
        )}
        from={{ name: Option.getOrElse(from, () => 'Someone') }}
      />
    ),
    Wake: ({ reason, name }) => {
      const line = SIGNAL_LINE[reason]
      return (
        <div className="flex items-center gap-2 text-meta font-meta text-ink-3">
          <line.Icon className="size-3.5" />
          <span>
            {line.label}
            {Option.isSome(name) && ` · ${name.value}`}
          </span>
        </div>
      )
    },
    // `Message` sends only `system` messages here, which are never a turn or a reply.
    Person: () => null,
    Vivid: () => null,
    Plumbing: () => null,
  })
}

/**
 * The bubble each stretch of Vivid's words is drawn in: the quiet fill with a hairline edge, at
 * the card's radius, so a reply reads as messages and not as a page of text. It leaves room on
 * the right as the Person's own bubbles leave room on the left. Markdown's first and last blocks
 * lose their outer margins, so the padding alone sets the bubble's edge.
 */
const BUBBLE =
  'w-fit max-w-bubble min-w-0 rounded-card border border-line-2 bg-surface-2 px-3.5 py-2.25 *:*:first:mt-0 *:*:last:mb-0'

/**
 * One stretch of what Vivid said, between two pieces of its work: each run of words a bubble of
 * its own, and each display it wrote drawn bare where it stands in them, never in a bubble (a
 * display is a thing to use, not words to read). A display is drawn from the first of its lines
 * to arrive, so it fills in as the reply does. Each part is keyed by where it starts in the
 * stretch, which never moves, so a display is not remounted (and keeps what the Person picked in
 * it) while the words after it are still coming.
 *
 * The words arrive in lumps and are let out evenly (`useRevealed`); only the stretch still being
 * written has anything left to let out, so the ones before it are whole from their first frame.
 */
function Written({
  source,
  text,
  making,
  streaming,
  settled,
  live,
  onSay,
}: {
  /** The reply as Flue stored it, which every program drawn from it names. */
  source: DisplaySource
  text: string
  /**
   * Whether Vivid is still making the newest reply and this is it. A display whose own end has
   * arrived still waits for the reply's: the server runs a program only from a reply it has stored
   * whole.
   */
  making: boolean
  /**
   * Whether this stretch is still streaming. It is checked beside `making` because a reply can
   * still be streaming after it stops being the newest thing in the Thread (the Person writes
   * while it arrives), and then `making` alone would let its Queries run early.
   */
  streaming: boolean
  /** Whether the submission this reply answers is settled; see `MessageProps.settled`. */
  settled: boolean
  /** Whether this reply is the newest thing in the Thread and Vivid has finished it. */
  live: boolean
  onSay: (words: string) => void
}) {
  const { drawn, fresh } = useRevealed(text, streaming)
  return stretches(drawn).map((stretch) => {
    if (stretch.kind === 'display') {
      return (
        <Display
          source={source}
          key={stretch.from}
          text={stretch.text}
          arriving={making || streaming || !settled || !stretch.whole}
          live={live}
          onSay={onSay}
        />
      )
    }
    // Only the space between two displays: nothing to put in a bubble.
    if (stretch.text.trim().length === 0) return null
    return (
      <div key={stretch.from} className={BUBBLE} data-vivid-bubble="">
        <Markdown content={stretch.text} fresh={fresh} />
      </div>
    )
  })
}

/** The cards a response's tool results ask for, in the order Vivid produced them. */
function ToolCards({
  tools,
  context,
  live,
}: {
  tools: ReadonlyArray<ToolPart>
  context: ThreadContext
  /** Whether this reply is the newest thing in the Thread and Vivid has finished it. */
  live: boolean
}) {
  return tools.map((tool) => {
    if (tool.state !== 'output-available') return null
    const card = cardFor(tool.output)
    if (Option.isNone(card)) return null
    const wanted = card.value
    switch (wanted.kind) {
      case 'connection':
        return (
          <ConnectionCard
            key={tool.toolCallId}
            id={tool.toolCallId}
            request={wanted.request}
            authorization={wanted.authorization}
            awaited={wanted.awaited}
            current={live}
            onCarryOn={(words) => carryOn(context.thread, words)}
          />
        )
      case 'approval': {
        const approval = approvalById(context.approvals, wanted.id)
        return Option.isNone(approval) ? null : (
          <AskedFirst key={tool.toolCallId} approval={approval.value} me={context.me} />
        )
      }
      case 'input': {
        const request = requestById(context.requests, wanted.id)
        return Option.isNone(request) ? null : (
          <Asked key={tool.toolCallId} request={request.value} me={context.me} />
        )
      }
    }
  })
}

/** Who Vivid was answering, in a shared Thread where that is not obvious. */
function answering(message: FlueConversationMessage, context: ThreadContext) {
  if (!context.shared) return Option.none<string>()
  const run = context.runs.find((candidate) => candidate.id === message.submissionId)
  return run === undefined ? Option.none<string>() : Option.some(run.origin.person.name)
}

/** What the copy control says for each thing that can have happened to the last press. */
const COPY = {
  idle: 'Copy message',
  copied: 'Copied',
  refused: 'Could not copy. Select the text instead.',
} satisfies Record<'idle' | 'copied' | 'refused', string>

/**
 * Copies a reply's words in one press. It is always there, quietly, beside the time: a control
 * that only appears on hover does not exist on a touch screen, and one more thing appearing under
 * the pointer is one more thing moving while reading.
 *
 * It stays its own small button and not an `IconButton`: it turns the danger ink when the copy
 * is refused. What it says is a tooltip, which stays up through the press (`closeOnClick` off),
 * so "Copied" or why it could not copy is read where the Person just pressed.
 */
function CopyWords({ read }: { read: () => string }) {
  const [state, setState] = useState<keyof typeof COPY>('idle')
  return (
    <Tooltip>
      <TooltipTrigger
        closeOnClick={false}
        render={
          <button
            type="button"
            aria-label={COPY[state]}
            onClick={() => {
              // Over plain http from another machine the browser has no clipboard at all.
              if (!('clipboard' in navigator)) {
                setState('refused')
                return
              }
              void navigator.clipboard.writeText(read()).then(
                () => setState('copied'),
                () => setState('refused'),
              )
            }}
            // Back to rest when the pointer or the keyboard leaves, so "Copied" is about this press.
            onBlur={() => setState('idle')}
            onMouseLeave={() => setState('idle')}
            className={cn(
              'inline-flex size-6 cursor-pointer items-center justify-center rounded-control transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink active:scale-96',
              state === 'refused' ? 'text-danger' : 'text-ink-3',
            )}
          />
        }
      >
        {state === 'copied' ? <Check className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </TooltipTrigger>
      <TooltipContent>{COPY[state]}</TooltipContent>
    </Tooltip>
  )
}

/** When a reply was finished, when Vivid said so. */
function Stamp({ message }: { message: FlueConversationMessage }) {
  const time = timeOf(message)
  return Option.isNone(time) ? null : <time title={time.value.full}>{time.value.said}</time>
}

/**
 * A reply as the Person reads it: what Vivid said and what it showed, in the order it happened.
 * Each stretch of words between two pieces of work is a message of its own (Duet and Grok Bot
 * both split a turn this way), and the work between them is drawn only where it left something
 * for the Person, a card (`ToolCards`). The phone splits a reply the same way
 * (`segmentsOf`, `apps/mobile/src/data/message.ts`).
 */
type Segment = Data.TaggedEnum<{
  Words: { readonly from: number; readonly text: string }
  Work: { readonly from: number; readonly tools: ReadonlyArray<ToolPart> }
}>
const Segment = Data.taggedEnum<Segment>()

/**
 * Splits a reply into its segments. Text parts that follow one another are one stretch of words,
 * joined as `textOf` joins them; tool calls that follow one another are one piece of work. Empty
 * words make no segment, so a reply that has only begun has none. `from` is the place of a
 * segment's first part in the reply, which never moves as more arrives, so a segment keeps its
 * identity (and a display in it what the Person picked) while the reply grows around it.
 */
const segmentsOf = (message: FlueConversationMessage): ReadonlyArray<Segment> => {
  const segments: Array<Segment> = []
  message.parts.forEach((part, from) => {
    const last = segments.at(-1)
    if (part.type === 'text' && part.text.trim().length > 0) {
      if (last !== undefined && Segment.$is('Words')(last)) {
        segments[segments.length - 1] = Segment.Words({
          from: last.from,
          text: `${last.text}\n\n${part.text}`,
        })
      } else segments.push(Segment.Words({ from, text: part.text }))
    }
    if (part.type !== 'dynamic-tool') return
    if (last !== undefined && Segment.$is('Work')(last)) {
      segments[segments.length - 1] = Segment.Work({
        from: last.from,
        tools: [...last.tools, part],
      })
    } else segments.push(Segment.Work({ from, tools: [part] }))
  })
  return segments
}

/** Whether a piece of work left the Person anything to see: a card among its tool results. */
const showsCard = (tools: ReadonlyArray<ToolPart>) =>
  tools.some((tool) => tool.state === 'output-available' && Option.isSome(cardFor(tool.output)))

/**
 * Whether a segment draws anything. Words always do; work does only where it left a card, since
 * the steps themselves are not drawn (the line at the foot of the Thread says the one Vivid is on,
 * `Doing.tsx`).
 */
const drawsSomething = (segment: Segment) =>
  Segment.$match(segment, { Words: () => true, Work: ({ tools }) => showsCard(tools) })

/** A card Vivid produces while it is making this reply rises into place; `contents` keeps the
 * wrapper out of the layout, so the card stands in the column like any message. */
const ARRIVING = 'contents *:motion-enter'

/**
 * Vivid's reply, as a run of messages: each stretch of words a bubble, with the cards its work
 * left between them. Its face stands once, at the foot of the run, as Messages draws a run of
 * bubbles from one sender, and the time and copy control stand under the last of them. The steps
 * it took are not drawn: the line at the foot of the Thread says the one it is on while it works
 * (`Doing.tsx`), and the owner asked that nothing of them stay in the Thread (26 October 2026).
 * Until then the reply had no bubble and a list of steps above its words (13 October 2026).
 */
function FromVivid({
  message,
  context,
  working,
  latest,
  settled,
  onContinue,
}: {
  message: FlueConversationMessage
  context: ThreadContext
  working: boolean
  latest: boolean
  settled: boolean
  onContinue: (text: string) => void
}) {
  const segments = segmentsOf(message).filter(drawsSomething)
  const forWhom = answering(message, context)
  const streaming = message.parts.some((part) => 'state' in part && part.state === 'streaming')
  // Only the newest reply can still be in the making; an older one is whole.
  const making = working && latest
  // A reply with nothing to show yet is not drawn: the line at the foot of the Thread already
  // says Vivid is on it.
  if (segments.length === 0 && Option.isNone(forWhom)) return null
  // Flue streams every step of a reply under the id of its first step, the id its history keeps
  // the whole reply under (`buildResponseMessageIndex` in @flue/runtime 2.2.2), so a display drawn
  // while the reply arrives already names the reply the server reads.
  const source = DisplaySource.cases.ThreadMessage.make({
    thread: context.thread,
    message: message.id,
  })
  const text = textOf(message)
  // Only the newest reply, once Vivid has finished it, offers its replies to tap.
  const offered = latest && !working && !streaming ? offeredReplies(message) : []
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-3">
        <ReplyFace message={message} latest={latest} making={making} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-body text-ink">
          {Option.isSome(forWhom) && (
            <span className="block text-meta font-meta text-ink-3">Answering {forWhom.value}</span>
          )}
          {segments.map((segment) =>
            Segment.$is('Words')(segment) ? (
              <Written
                key={`words-${segment.from}`}
                source={source}
                text={segment.text}
                making={making}
                // Only the last stretch can still be arriving; the ones before it are whole.
                streaming={streaming && segment === segments.at(-1)}
                settled={settled}
                live={latest && !working}
                onSay={onContinue}
              />
            ) : (
              <div key={`work-${segment.from}`} className={making ? ARRIVING : 'contents'}>
                <ToolCards tools={segment.tools} context={context} live={latest && !working} />
              </div>
            ),
          )}
        </div>
      </div>
      {!making && !streaming && text.length > 0 && (
        // In the column the bubbles are read in, under the last of them, clear of the face.
        <Settled message={message} text={text} latest={latest} />
      )}
      {offered.length > 0 && <Replies replies={offered} onSay={onContinue} />}
    </div>
  )
}

/**
 * The face beside a reply. The newest reply's is alive: it works while a step of the reply runs,
 * thinks between steps, and is pleased, then at rest, once the reply is made. An older reply is a
 * record, and its face is still.
 */
function ReplyFace({
  message,
  latest,
  making,
}: {
  message: FlueConversationMessage
  latest: boolean
  making: boolean
}) {
  if (!latest) return <Face size={28} mood="neutral" />
  return <Alive size={28} state={stateOf(making, Option.isSome(stepIn(message)))} />
}

/**
 * What stands under a finished reply: when it was said, and the control that copies it. Under
 * the newest reply it fades in (`motion-fade`) as the words stop arriving, so the reply is seen
 * to settle; under older ones it is simply there.
 */
function Settled({
  message,
  text,
  latest,
}: {
  message: FlueConversationMessage
  text: string
  latest: boolean
}) {
  return (
    <div
      className={cn(
        'flex h-6 items-center gap-1.5 ps-10 text-meta text-ink-3',
        latest && 'motion-fade',
      )}
    >
      <Stamp message={message} />
      <CopyWords read={() => text} />
    </div>
  )
}

/**
 * What Vivid's face is doing beside its newest reply: working while a step of it runs, thinking
 * between steps, and done once it is made (pleased for a few seconds, then at rest).
 */
const stateOf = (making: boolean, usingTool: boolean) => {
  if (!making) return 'done'
  return usingTool ? 'working' : 'thinking'
}
