import type { FlueConversationMessage } from '@flue/react'
import {
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
  Source,
  sourceOf,
  speakerOfTurn,
  stretches,
  thisReader,
} from '@vivid/state'
import { Option, Schema } from 'effect'
import { AlarmClock, Check, Copy as CopyIcon } from 'lucide-react'
import { memo, useState } from 'react'
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
import { Doing, doingIn, Trail, type ToolPart } from './Trail'

const Metadata = Schema.Struct({
  finishedAt: Schema.optionalKey(Schema.Finite),
  startedAt: Schema.optionalKey(Schema.Finite),
})
const decodeMetadata = Schema.decodeUnknownOption(Metadata)

/** What the Thread carries beside its messages, which the cards and attributions are drawn from. */
export interface ThreadContext {
  readonly thread: Option.Option<ThreadId>
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
 * What Vivid said: its words, with each display it wrote drawn where it stands in them. A display
 * is drawn from the first of its lines to arrive, so it fills in as the reply does. Each stretch is
 * keyed by where it starts in the reply, which never moves, so a display is not remounted (and
 * keeps what the Person picked in it) while the words after it are still coming.
 */
function Written({
  thread,
  text,
  fresh,
  live,
  onSay,
}: {
  thread: Option.Option<ThreadId>
  text: string
  fresh: boolean
  /** Whether this reply is the newest thing in the Thread and Vivid has finished it. */
  live: boolean
  onSay: (words: string) => void
}) {
  return stretches(text).map((stretch) =>
    stretch.kind === 'words' ? (
      <Markdown key={stretch.from} content={stretch.text} fresh={fresh} />
    ) : (
      <Display
        thread={thread}
        key={stretch.from}
        text={stretch.text}
        arriving={!stretch.whole}
        live={live}
        onSay={onSay}
      />
    ),
  )
}

/** The cards a response's tool results ask for, in the order Vivid produced them. */
function ToolCards({
  tools,
  context,
  live,
  onContinue,
}: {
  tools: ReadonlyArray<ToolPart>
  context: ThreadContext
  /** Whether this reply is the newest thing in the Thread and Vivid has finished it. */
  live: boolean
  onContinue: (text: string) => void
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
            onContinue={onContinue}
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
 * Vivid's reply, in the open reading column beside its face. It has no bubble: a short reply used
 * to get one and lose it mid-sentence when it grew a list or a second paragraph, and the owner
 * asked for it gone (13 October 2026).
 */
function FromVivid({
  message,
  context,
  working,
  latest,
  onContinue,
}: {
  message: FlueConversationMessage
  context: ThreadContext
  working: boolean
  latest: boolean
  onContinue: (text: string) => void
}) {
  const text = textOf(message)
  const tools = message.parts.filter((part) => part.type === 'dynamic-tool')
  const forWhom = answering(message, context)
  const streaming = message.parts.some((part) => 'state' in part && part.state === 'streaming')
  // What is drawn of it: the words arrive in lumps and are let out evenly (`useRevealed`).
  const { drawn: drawnText, fresh } = useRevealed(text, streaming)
  // Only the newest reply can still be in the making; an older one's steps are its record.
  const making = working && latest
  return (
    <div className="flex gap-3">
      <ReplyFace message={message} latest={latest} making={making} />
      <div className="min-w-0 flex-1 text-body text-ink">
        {Option.isSome(forWhom) && (
          <span className="mb-1 block text-meta font-meta text-ink-3">
            Answering {forWhom.value}
          </span>
        )}
        {making && <Doing tools={tools} wordless={text.length === 0} />}
        {text.length > 0 && (
          <Written
            thread={context.thread}
            text={drawnText}
            fresh={fresh}
            live={latest && !working}
            onSay={onContinue}
          />
        )}
        {!streaming && text.length > 0 && <Settled message={message} text={text} latest={latest} />}
        {!making && <Trail tools={tools} />}
        {/* A card Vivid produces while it is making this reply rises into place; the cards of a
            reply that is already finished are simply there. `contents` keeps the wrapper out of
            the layout. */}
        <div className={making ? ARRIVING : 'contents'}>
          <ToolCards
            tools={tools}
            context={context}
            live={latest && !working}
            onContinue={onContinue}
          />
        </div>
      </div>
    </div>
  )
}

/** The wrapper of a reply's cards while the reply is being made: each card that appears rises in. */
const ARRIVING = 'contents *:motion-enter'

/**
 * The face beside a reply. The newest reply's is alive: it works while the reply is made and is
 * pleased, then at rest, once it is finished. An older reply is a record, and its face is still.
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
  if (!latest) return <Face size={28} className="mt-0.5" mood="neutral" />
  return (
    <Alive size={28} className="mt-0.5" state={stateOf(making, Option.isSome(doingIn(message)))} />
  )
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
        'flex h-6 items-center gap-1.5 text-meta text-ink-3',
        'mt-1',
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
