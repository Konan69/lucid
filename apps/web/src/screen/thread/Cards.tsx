import {
  ActionTarget,
  ApprovalId,
  ApprovalState,
  ConnectionAuthorization,
  ConnectionAuthorizationMessage,
  ConnectionRequestMessage,
  type AccountName,
  type ArtifactReference,
  type Connection,
  HandoffId,
  type HandoffRequest,
  InputRequestId,
  type Approval,
  type InputRequest,
  type PersonId,
} from '@vivid/contracts'
import { Data, Effect, Option, Predicate, Result, Schema } from 'effect'
import {
  access,
  answered,
  answering,
  artifacts,
  Awaited,
  awaitedOf,
  awaitedWords,
  browserStep,
  changedLine,
  CardPress,
  cardPress,
  connecting,
  desktopStep,
  form,
} from '@vivid/state'
import { Check, X } from 'lucide-react'
import { BorderBeam } from 'border-beam'
import type { ReactNode } from 'react'
import {
  carriedOn,
  dismiss,
  finish,
  keyingFor,
  press,
  standingForCard,
  useAttempt,
  waitingOn,
} from '../../data/connecting'
import { act } from '../../data/app'
import { changing, live, useLiveValue } from '../../data/live'
import { orSay } from '../../data/said'
import { openSettings } from '../../router'
import { themeShown, useTheme } from '../../data/theme'
import { Button } from '../../ui/button'
import { Card } from '../../ui/card'
import { Markdown } from '../../ui/Markdown'
import { cn } from '../../ui/cn'
import { EnterKey } from '../integration/Key'
import { Mark } from '../integration/Mark'
import { NameAccount } from '../integration/Name'

/**
 * What a Thread shows where a tool's output asks for more than a plain message: a service Vivid
 * needs connected is a card (`ConnectionCard`); something Vivid wants to do and needs a yes for
 * is its own words (`AskedFirst`) and a banner attached to the composer (`Allow.tsx`); a
 * question Vivid could not answer alone is its own words too (`Question.tsx`) and a banner
 * (`Choices.tsx`). This file reads which of these a tool call stands for.
 * Each is drawn from the server's record, so it keeps telling the truth after it is settled:
 * who allowed it, what came back, or that it ran out.
 */

const decodeApprovalRequest = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal('approval-request'), approvalId: ApprovalId }),
)
const decodeInputRequest = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal('input-request'), requestId: InputRequestId }),
)
const decodeHandoff = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal('handoff'), handoffId: HandoffId }),
)
const decodeConnectionRequest = Schema.decodeUnknownOption(ConnectionRequestMessage)
// An integration Vivid has already started adding carries what comes next: a sign-in or a key.
const decodeAuthorization = Schema.decodeUnknownOption(ConnectionAuthorizationMessage)
type ConnectionAuthorizationValue = typeof ConnectionAuthorization.Type

/** What a tool's output asks the Thread to draw, when it asks for anything. */
export type CardRequest =
  | { readonly kind: 'approval'; readonly id: ApprovalId }
  | { readonly kind: 'input'; readonly id: InputRequestId }
  | { readonly kind: 'handoff'; readonly id: HandoffId }
  /** A file or document Vivid delivered (`write_document`, `publish_file`). */
  | { readonly kind: 'artifact'; readonly artifact: typeof ArtifactReference.Type }
  | {
      readonly kind: 'connection'
      readonly request: ConnectionRequestMessage
      /** What finishing it takes, when Vivid has already begun adding it. */
      readonly authorization: Option.Option<ConnectionAuthorizationValue>
      /** Which accounts answer it: any on the service, the one Vivid began, or one more. */
      readonly awaited: Awaited
    }

/** Reads a tool's output for a card. Outputs that are not cards are simply not cards. */
export function cardFor(
  output: Parameters<typeof decodeApprovalRequest>[0],
): Option.Option<CardRequest> {
  const approval = decodeApprovalRequest(output)
  if (Option.isSome(approval))
    return Option.some({ kind: 'approval', id: approval.value.approvalId })
  const input = decodeInputRequest(output)
  if (Option.isSome(input)) return Option.some({ kind: 'input', id: input.value.requestId })
  const handoff = decodeHandoff(output)
  if (Option.isSome(handoff)) return Option.some({ kind: 'handoff', id: handoff.value.handoffId })
  const artifact = artifacts.deliveredArtifact(output)
  if (Option.isSome(artifact)) return Option.some({ kind: 'artifact', artifact: artifact.value })
  return Option.map(decodeConnectionRequest(output), (request) => ({
    kind: 'connection',
    request,
    authorization: Option.map(decodeAuthorization(output), (message) => message.authorization),
    awaited: awaitedOf(output),
  }))
}

/** A field's name as a person reads it: `reply_to` and `replyTo` are both "Reply to". */
const fieldName = (key: string) => {
  const words = key
    .replaceAll('_', ' ')
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .trim()
    .toLocaleLowerCase()
  return words.slice(0, 1).toLocaleUpperCase() + words.slice(1)
}

/**
 * One value of an action, as it will be sent, without losing what kind of value it is. Text is
 * shown as text. A number, true, false or nothing is shown as itself, set apart from text, so the
 * word "false" and the value false cannot be mistaken for each other. A list is one item to a
 * line, so "a, b" as one item is not two. Anything nested is shown whole.
 */
function Value({ value }: { value: Schema.Json }) {
  if (Predicate.isString(value)) {
    return <span className="wrap-break-word whitespace-pre-wrap text-ink">{value}</span>
  }
  if (Array.isArray(value)) {
    return (
      <ol className="flex flex-col gap-0.5">
        {value.map((item, position) => (
          // A list's items have no identity but their place, and the list is drawn once.
          // oxlint-disable-next-line react/no-array-index-key
          <li key={position} className="flex gap-2">
            <span className="shrink-0 text-ink-3 tabular-nums">{position + 1}.</span>
            <Value value={item} />
          </li>
        ))}
      </ol>
    )
  }
  return (
    <code className="font-mono wrap-break-word whitespace-pre-wrap text-ink-2">
      {isRecord(value) ? JSON.stringify(value, null, 2) : String(value)}
    </code>
  )
}

/** A JSON object, as opposed to a list or a single value. The guard keeps its values typed. */
const isRecord = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

/**
 * The fields of an action's input, in the order they were written. Each keeps its own key beside
 * the friendly name: two keys can read the same once tidied (`reply_to`, `replyTo`), and an
 * Approval must not blur which is which.
 */
const fieldsOf = (input: Schema.Json): ReadonlyArray<readonly [string, Schema.Json]> =>
  isRecord(input) ? Object.entries(input) : [['details', input] as const]

/**
 * Exactly what would be done, in full: the account it would use and every field as it would be
 * sent (who it goes to, the subject, the whole message), or the whole step on the Computer. An
 * Approval is consent to one specific action, and its banner says that action in one sentence;
 * this is what the sentence stands for, which the banner opens on request (`Allow.tsx`,
 * "Details"). It is plain lines with no fill or edge of its own: it is read inside the banner,
 * which is already a surface, and the banner's box is what scrolls.
 */
export function Exactly({ target }: { target: ActionTarget }) {
  if (ActionTarget.guards.Connection(target)) {
    return (
      <div className="flex flex-col gap-1.5">
        {/* In full and wrapping: the account is where the action lands. */}
        <p className="wrap-anywhere text-ink-2">
          {target.account} <span className="text-ink-3">· {fieldName(target.tool)}</span>
        </p>
        <dl className="flex flex-col gap-1.5">
          {fieldsOf(target.input).map(([key, value]) => (
            <div key={key}>
              {/* The name as a person reads it. The key it is sent under was beside it in
                  mono until 12 October 2026 ("Question question"): a developer's detail. */}
              <dt className="text-meta font-meta text-ink-3">{fieldName(key)}</dt>
              <dd>
                <Value value={value} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }
  return (
    <p className="font-mono wrap-anywhere whitespace-pre-wrap text-ink-2">
      {ActionTarget.match(target, {
        Connection: ({ account, tool }) => `${account} · ${tool}`,
        Browser: ({ action }) => browserStep(action),
        Desktop: ({ action }) => desktopStep(action),
      })}
    </p>
  )
}

const SETTLED = 'inline-flex items-center gap-1.5 text-label'

/**
 * How an Approval that is no longer waiting ended, in a sentence. An Integration's that ran out
 * says nothing was sent: it paused before its call ran (`form.EXPIRED_APPROVAL`).
 */
function ApprovalOutcome({ approval }: { approval: Approval }) {
  if (form.approvalExpired(approval))
    return <span className={cn(SETTLED, 'text-ink-3')}>{form.EXPIRED_APPROVAL}</span>
  return ApprovalState.match(approval.state, {
    Pending: () => null,
    Executing: ({ decidedBy }) => (
      <span className={cn(SETTLED, 'text-working')}>
        Allowed by {decidedBy.name}. Doing it now…
      </span>
    ),
    Succeeded: ({ decidedBy }) => (
      <span className={cn(SETTLED, 'text-success')}>
        <Check className="size-3.5" />
        Done. Allowed by {decidedBy.name}.
      </span>
    ),
    Failed: ({ reason }) => (
      <span className={cn(SETTLED, 'text-danger')}>It did not work: {reason}</span>
    ),
    OutcomeUnknown: () => (
      <span className={cn(SETTLED, 'text-attention')}>
        Vivid cannot tell whether this happened. Check before trying again.
      </span>
    ),
    Denied: ({ decidedBy }) => (
      <span className={cn(SETTLED, 'text-ink-3')}>
        <X className="size-3.5" />
        Not allowed by {decidedBy.name}.
      </span>
    ),
    Expired: () => <span className={cn(SETTLED, 'text-ink-3')}>This request expired.</span>,
    Withdrawn: () => <span className={cn(SETTLED, 'text-ink-3')}>Withdrawn.</span>,
    Invalidated: ({ reason }) => (
      <span className={cn(SETTLED, 'text-ink-3')}>{changedLine(reason)}</span>
    ),
  })
}

/**
 * Something Vivid asked to do, as the Thread's conversation holds it: a quiet line that says it
 * asked first, and what it asked to do in its own words, drawn as its words are anywhere. Under
 * them is one line of how it ended, once it has; while it waits on somebody else, who that is,
 * since nothing else on this Person's screen says so.
 *
 * The ways to answer are not in the conversation. While it waits on the Person looking at it,
 * it is a banner attached to the composer (`Allow.tsx`), as a question of Vivid's is
 * (`Question.tsx`, `Choices.tsx`).
 *
 * Until 12 October 2026 this was a card in the conversation, with a chip for the action's
 * effect, Vivid's reason, every field of the action in a box inside the card and three buttons.
 * The owner rejected it as a developer's tool: too many boxes in boxes and too many words.
 */
export function AskedFirst({
  approval,
  requests,
  me,
}: {
  approval: Approval
  /** The Thread's questions: an Integration may ask one mid-call after this was allowed. */
  requests: ReadonlyArray<InputRequest>
  me: PersonId
}) {
  const pending = ApprovalState.guards.Pending(approval.state)
  return (
    <div className="mt-3">
      <p className="text-meta font-meta text-ink-3">Asked first</p>
      {/* A sentence with no place to break (an address, a link) breaks anywhere, and it takes its
          direction from its own first strong letter. */}
      <div dir="auto" className="mt-1 wrap-anywhere">
        <Markdown content={approval.action.summary} />
      </div>
      {pending && approval.askedOf.id !== me && (
        <p className="mt-1 text-label text-ink-3">Waiting on {approval.askedOf.name}.</p>
      )}
      {!pending && (
        <p className="mt-1">
          <ApprovalOutcome approval={approval} />
        </p>
      )}
      {form.followingExpired(approval, requests).map((line) => (
        <p key={line} className="mt-1 text-label text-ink-3">
          {line}
        </p>
      ))}
    </div>
  )
}

/** One sentence the card says about its own attempt, and whether it is a fault to be read at once. */
interface Said {
  readonly words: string
  readonly urgent: boolean
}

const NOT_STARTED = Option.some<Said>({
  words: 'That did not start. It may not be available on this server yet.',
  urgent: true,
})

/**
 * What the card says about its own attempt, from where it stands in the machine (`connecting` in
 * `@vivid/state`), when it says anything. A press that is on its way and a key being asked for
 * are said by the button and the dialog; only a sign-in in its tab, one the Person came back from
 * without finishing, and an attempt that ended without an account have a sentence. An unfinished
 * sign-in is not a fault (people look at the page and leave), so it is said calmly, by the
 * service's name. The phone says the same (`cardSaid`, `apps/mobile/src/data/integration.ts`).
 */
const saidAfter = (standing: connecting.Standing, serviceName: string) =>
  connecting.Standing.match<Option.Option<Said>>(standing, {
    Still: () => Option.none(),
    Starting: () => Option.none(),
    Away: () => Option.some({ words: 'Finish signing in in the browser', urgent: false }),
    Checking: () => Option.none(),
    Keying: () => Option.none(),
    Unfinished: () => Option.some({ words: `${serviceName} is not signed in yet.`, urgent: false }),
    Connected: () => Option.none(),
    Refused: ({ refusal }) =>
      connecting.Refusal.match<Option.Option<Said>>(refusal, {
        NotBegun: () => NOT_STARTED,
        Blocked: () =>
          Option.some({
            words: 'The sign-in page could not open. Allow pop-ups for this page and try again.',
            urgent: true,
          }),
        Unopened: () => NOT_STARTED,
        // A key form that could not be brought up is a press that did not start.
        Unshown: () => NOT_STARTED,
        // The service did not take the key, and the server takes no second one for the
        // account. The card does not send the Person away to replace it: a card that waits for
        // this very account would never be answered by another. Its button carries on instead.
        Unusable: (unusable) =>
          Option.some({ words: `${unusable.serviceName} did not accept that.`, urgent: true }),
      }),
  })

/**
 * The card's way in before anything is pressed: what its button says, the line under the name
 * that says what finishing it takes, and the button's word for its first wait. It comes from what
 * Vivid already began (a sign-in, a key) or, when it began nothing, from which accounts answer it.
 */
interface Way {
  readonly label: string
  readonly line: string
  readonly starting: string
}

const wayIn = (authorization: Option.Option<ConnectionAuthorizationValue>, awaited: Awaited) =>
  Option.match(authorization, {
    onNone: (): Way =>
      Awaited.$is('Another')(awaited)
        ? { label: 'Add account', line: 'Add another account', starting: 'Connecting…' }
        : { label: 'Connect', line: 'Not connected yet', starting: 'Connecting…' },
    onSome: (begun) =>
      ConnectionAuthorization.match(begun, {
        OpenSignIn: (): Way => ({
          label: 'Sign in',
          line: 'Sign in to connect',
          starting: 'Opening…',
        }),
        EnterKey: (): Way => ({
          label: 'Add key',
          line: 'Needs an API key to connect',
          starting: 'Opening…',
        }),
      }),
  })

/**
 * Vivid needs a service to go on. The card is one row in every state: the service's logo, its
 * name with one line under it that says where it stands for the Person, and at most one thing to
 * press. The line is never the reason Vivid was given (the owner, 26 October 2026: that text is
 * written for the model, "why is it telling the user to call find tools?"). The press starts the
 * same attempt Settings makes, right here: a sign-in opens in its own tab, a key is typed into the
 * card itself and goes straight to the Integration (never into the Thread, never to Vivid).
 * Whether it is connected is read live, so the card settles by itself, and Vivid carries on
 * without being told. The phone's card is the same row (`apps/mobile/src/screen/integration/Card.tsx`).
 *
 * Where the attempt stands is not kept by the card. It is in the page's one machine
 * (`data/connecting.ts`), found by the tool call this card stands for, so an answer that comes
 * late cannot write over a newer press and a card drawn again says what the one before it said.
 *
 * Which accounts settle it is `awaited`. A service Vivid offered is settled by any ready account
 * on it. An Integration Vivid began is settled by that one. One more account, which Vivid asks
 * for when the Person wants an account that is not among theirs (their work Gmail), is settled
 * only by an account begun after Vivid asked: the card then says "Another … account" and offers
 * to add one although the service is already connected.
 */
export function ConnectionCard({
  id,
  request,
  authorization,
  awaited,
  current,
  onCarryOn,
}: {
  /** The tool call this card stands for, which names its one "carry on". */
  id: string
  request: ConnectionRequestMessage
  authorization: Option.Option<ConnectionAuthorizationValue>
  awaited: Awaited
  /** Whether this is the newest thing in the Thread and Vivid has stopped to wait for it. */
  current: boolean
  /** Tells Vivid to go on, unseen (`carryOn` in `data/threads.ts`): never the Person's words. */
  onCarryOn: (message: string) => void
}) {
  const connections = useLiveValue(live.connections)
  const attempt = useAttempt()
  const shown = useTheme(themeShown)
  const list = Option.match(connections, { onNone: () => [], onSome: (value) => value.connections })
  // A request for one more account is never ready when it is made, whatever the card was told.
  const ready =
    (Awaited.$is('Service')(awaited) && request.ready) || answered(list, request, awaited)
  const words = awaitedWords(awaited, request.serviceName)
  const standing = standingForCard(attempt, id)
  const keying = keyingFor(attempt, Option.some(id))
  const way = wayIn(authorization, awaited)
  // The service's own logo: the one the live list has for an account on it, which is the only
  // artwork an added server has; a catalog service is drawn from the bundled logos (`Mark`).
  const mark = Option.flatMap(
    Option.fromUndefinedOr(list.find((connection) => connection.service === request.service)),
    (connection) => Option.fromNullishOr(connection.mark),
  )
  // What one press does, from the accounts as they stand: an Integration that was begun and left
  // unfinished is picked up, not begun a second time, and one more account on a service that
  // does not say who signs in is named first, as "Add account" in Settings does.
  const next = cardPress(list, request, awaited)
  const begin = (name: Option.Option<AccountName>) => ({
    pressed: request.service,
    asked: connecting.Asked.cases.Begin.make({ service: request.service, shared: false, name }),
  })

  /**
   * One press. The machine is told which card pressed, and the card is owed its carry-on from
   * then: when the attempt ends in an account the Thread goes on by itself, said with the
   * account that was connected, so one more account is named and Vivid does not have to guess
   * which of several is new.
   */
  const connect = (name: Option.Option<AccountName>) =>
    press({
      ...CardPress.$match(next, {
        Resume: ({ id: begun }) => ({
          pressed: begun,
          asked: connecting.Asked.cases.Resume.make({ id: begun }),
        }),
        Name: () => begin(name),
        Begin: () => begin(name),
      }),
      // A sign-in tab is opened by the click itself when a sign-in is known to be coming.
      signIn: Option.exists(authorization, ConnectionAuthorization.guards.OpenSignIn),
      card: Option.some({
        id,
        carryOn: (connection) => onCarryOn(words.carryOn(Option.some(connection))),
      }),
    })

  /**
   * "Carry on" from an attempt that ended without an account the service would take: Vivid is
   * told what happened and decides what to do next. Nothing is owed for it, as for any carry-on
   * made by hand.
   */
  const giveUp = (message: string) => {
    carriedOn(id)
    onCarryOn(message)
  }

  /** "Carry on" by hand: said with the list as it stands, and no longer owed by an attempt. */
  const carryOn = () => {
    carriedOn(id)
    onCarryOn(words.carryOn(answering(list, request, awaited)))
  }

  const said = saidAfter(standing, request.serviceName)
  const urgent = Option.filter(said, (line) => line.urgent)
  return (
    // While it is the thing the Thread is waiting on, its edge breathes like an Approval's.
    <Edged>
      <BorderBeam
        active={current && !ready}
        size="pulse-inner"
        colorVariant="mono"
        strength={0.6}
        theme={shown}
      >
        <Card size="sm" className="px-3">
          <div className="flex items-center gap-3">
            <Mark service={{ name: request.serviceName, mark: Option.getOrNull(mark) }} size={36} />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-title font-strong text-ink">{words.title}</h3>
              {/* The line changes as the attempt moves on; it is said when it does. */}
              <p
                role="status"
                className={cn('truncate text-label', ready ? 'text-success' : 'text-ink-2')}
              >
                {ready ? 'Connected' : lineOf(said, way)}
              </p>
            </div>
            <ConnectionAction
              label={words.connect}
              way={way}
              naming={
                CardPress.$is('Name')(next)
                  ? Option.some({
                      service: request.serviceName,
                      held: list.filter((connection) => connection.service === request.service),
                    })
                  : Option.none()
              }
              ready={ready}
              current={current}
              standing={standing}
              waiting={waitingOn(attempt)}
              onConnect={connect}
              onCarryOn={carryOn}
              onGiveUp={giveUp}
            />
          </div>
          {/* What did not happen is said under the row, in the column its words are read in. */}
          {!ready && Option.isSome(urgent) && (
            <p role="alert" className="ps-12 text-label text-pretty text-danger">
              {urgent.value.words}
            </p>
          )}
          {/* Open exactly while this card's own attempt is waiting for a key, in the column the
              card's words are read in. */}
          {Option.isSome(keying) && (
            <div className="ps-12 pt-2 pb-1">
              <EnterKey keying={keying.value} onClose={dismiss} onAnswered={finish} />
            </div>
          )}
        </Card>
      </BorderBeam>
    </Edged>
  )
}

/**
 * The line under a card's name while it is not connected: what its attempt has to say when that
 * is calm news (finish in the browser, not signed in yet), else what finishing it takes. A fault
 * keeps the card's own line here and is said under the row, where it is read as one.
 */
const lineOf = (said: Option.Option<Said>, way: Way) =>
  Option.match(
    Option.filter(said, (line) => !line.urgent),
    { onNone: () => way.line, onSome: (line) => line.words },
  )

/**
 * The edge of a card that has a beam. The beam clips whatever it wraps to its own box, and a
 * card's edge is a shadow that falls just outside that box, so inside a beam the card lost its
 * edge and sat on the light page as white on near-white. The edge is drawn here, outside the
 * beam, at the card's own radius. A one-row card wider than a message reads as stretched, so it
 * keeps a message's width.
 */
function Edged({ children }: { children: ReactNode }) {
  return <div className="w-full max-w-md rounded-card edge">{children}</div>
}

/**
 * The one thing to press on the card, when there is one. A connected card has nothing to press
 * ("Connected" says it all), except "Carry on" while the Thread is still waiting on it.
 */
function ConnectionAction({
  label,
  way,
  naming,
  ready,
  current,
  standing,
  waiting,
  onConnect,
  onCarryOn,
  onGiveUp,
}: {
  /** What the press does, for a screen reader: "Connect Gmail", "Add another Gmail account". */
  label: string
  way: Way
  /**
   * The service whose new account is asked a name for before it is begun, when one is, with the
   * accounts already on it: a name one of them has cannot be given again.
   */
  naming: Naming
  ready: boolean
  current: boolean
  /** Where this card's own attempt stands. */
  standing: connecting.Standing
  /** Whether nothing can be pressed for now: the server is being asked, here or anywhere. */
  waiting: boolean
  onConnect: (name: Option.Option<AccountName>) => void
  onCarryOn: () => void
  /** Carries the Thread on with what happened, when the attempt cannot be made again here. */
  onGiveUp: (message: string) => void
}) {
  if (ready) {
    // Reached when the service was connected somewhere else (Settings, another device), where no
    // press here was owed its carry-on. Once the Thread has moved on there is nothing to press.
    return current ? (
      <Button size="pill" onClick={onCarryOn}>
        Continue
      </Button>
    ) : null
  }
  /** The button at one point of an attempt: what it says, and whether a name is asked first. */
  const says = (words: string) => Offer.Press({ words, naming, quiet: false })
  // What there is to press, from where the card's own attempt stands.
  const offer = connecting.Standing.match<Offer>(standing, {
    Still: () => says(way.label),
    // Beginning can take the server many seconds; the button says so from the press.
    Starting: () => says(way.starting),
    // Once a press is waiting on a sign-in, pressing again opens it again: no second name is
    // asked, and it is the quiet button, since the thing to do now is in the browser.
    Away: () => Offer.Press({ words: 'Open it again', naming: Option.none(), quiet: true }),
    Checking: () => says('Checking…'),
    Keying: () => says(way.label),
    // The account was begun and is in the list unfinished, so this press picks it up
    // (`cardPress`) and no second name is asked.
    Unfinished: () => Offer.Press({ words: 'Try again', naming: Option.none(), quiet: false }),
    Connected: () => says(way.label),
    Refused: ({ refusal }) =>
      connecting.Refusal.match<Offer>(refusal, {
        NotBegun: () => Offer.Settings(),
        Blocked: () => says(way.label),
        Unopened: () => Offer.Settings(),
        Unshown: () => Offer.Settings(),
        Unusable: ({ serviceName }) =>
          Offer.CarryOn({ message: `${serviceName} did not accept that key.` }),
      }),
  })
  return offered(offer, { label, waiting, current, onConnect, onGiveUp })
}

/**
 * Draws what a card offers to press. A projection of the offer onto its control, as a plain
 * function and not a component: it holds nothing, and each branch is drawn in the card's own
 * render.
 */
const offered = (
  offer: Offer,
  card: {
    readonly label: string
    readonly waiting: boolean
    readonly current: boolean
    readonly onConnect: (name: Option.Option<AccountName>) => void
    readonly onGiveUp: (message: string) => void
  },
) =>
  Offer.$match(offer, {
    Press: ({ words, naming, quiet }) => (
      <ConnectButton
        says={words}
        label={card.label}
        quiet={quiet}
        waiting={card.waiting}
        naming={naming}
        onConnect={card.onConnect}
      />
    ),
    Settings: () => (
      <Button variant="outline" size="pill" onClick={() => void openSettings('connections')}>
        Open Integrations
      </Button>
    ),
    // Offered only while the Thread is waiting on this card: once it has been carried on, the
    // same words must not be sent to Vivid a second time.
    CarryOn: ({ message }) =>
      card.current ? (
        <Button size="pill" onClick={() => card.onGiveUp(message)}>
          Continue
        </Button>
      ) : null,
  })

/**
 * What a card that is not ready offers to press, from where its own attempt stands.
 *
 * - `Press`: make the attempt (again): what the button says, whether a name is asked first, and
 *   whether it is the quiet button (the thing to do now is elsewhere, in the browser).
 * - `Settings`: the server would not begin it. It is not pressed again here; Settings is
 *   offered, which says more.
 * - `CarryOn`: the service did not take the key, and the server takes no second one for the
 *   account. Pressing again would pick up an account the server refuses, and replacing it in
 *   Settings would never answer a card that waits for this very account, so the Thread would be
 *   stuck. The card carries the Thread on with `message` instead: Vivid hears what happened and
 *   decides what to do next.
 */
type Offer = Data.TaggedEnum<{
  Press: { readonly words: string; readonly naming: Naming; readonly quiet: boolean }
  Settings: {}
  CarryOn: { readonly message: string }
}>
const Offer = Data.taggedEnum<Offer>()

/** The accounts a new one must be told apart from, and the service they are on. */
type Naming = Option.Option<{
  readonly service: string
  readonly held: ReadonlyArray<Connection>
}>

/**
 * The card's button. It is the same button and the same press at every point of an attempt; what
 * changes is what it says. Where a name is wanted for the new account it asks for one first, and
 * the name it is given is what the press is made with.
 */
function ConnectButton({
  says,
  label,
  quiet,
  waiting,
  naming,
  onConnect,
}: {
  says: string
  label: string
  quiet: boolean
  waiting: boolean
  naming: Naming
  onConnect: (name: Option.Option<AccountName>) => void
}) {
  const variant = quiet ? 'outline' : 'default'
  if (Option.isNone(naming)) {
    return (
      <Button
        variant={variant}
        size="pill"
        aria-label={label}
        disabled={waiting}
        onClick={() => onConnect(Option.none())}
      >
        {says}
      </Button>
    )
  }
  return (
    <NameAccount
      trigger={
        <Button variant={variant} size="pill" aria-label={label} disabled={waiting}>
          {says}
        </Button>
      }
      title="Name the new account"
      why={`${naming.value.service} does not say who signs in. A name is how you and Vivid tell your accounts apart.`}
      action="Connect"
      current={Option.none()}
      others={naming.value.held}
      optional={false}
      onName={onConnect}
    />
  )
}

/**
 * A call through one of the Person's accounts that the account could not make, drawn where Vivid
 * stopped, with the one thing that lets it go on (`access.Escalation`):
 *
 * - The Person keeps a kind of data from Vivid on this account (`Declined`): "Allow" lifts it for
 *   the classes the call needed, the same switch Settings has, and the Thread carries on. "Keep
 *   it out" carries the Thread on with the Person's no, so Vivid answers without it.
 * - The account was not given what the call needs (`MoreAccess`): an account waiting on a sign-in
 *   is picked up where it stopped ("Reconnect"); a working one is signed in to again from the
 *   start ("Sign in again"), since the service only grants more on a new sign-in. Either way the
 *   Thread carries on with the account that came back.
 *
 * It is the same one-row card as `ConnectionCard`, so a Thread has one way of asking for access.
 */
export function AccessCard({
  id,
  escalation,
  current,
  onCarryOn,
}: {
  /** The tool call this card stands for, which names its one "carry on". */
  id: string
  escalation: access.Escalation
  /** Whether this is the newest thing in the Thread and Vivid has stopped to wait for it. */
  current: boolean
  onCarryOn: (message: string) => void
}) {
  const connections = useLiveValue(live.connections)
  const list = Option.match(connections, { onNone: () => [], onSome: (value) => value.connections })
  const connection = Option.fromUndefinedOr(
    list.find((each) => each.account === escalation.account),
  )
  const mark = Option.match(connection, {
    onNone: () => ({ name: escalation.account }),
    onSome: (each) => ({ name: each.serviceName, mark: each.mark }),
  })
  return (
    <Edged>
      <Card size="sm" className="px-3">
        <div className="flex items-center gap-3">
          <Mark service={mark} size={36} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-title font-strong text-ink">{escalation.account}</h3>
            {access.Escalation.$match(escalation, {
              Declined: (declined) => (
                <DeclinedAction
                  id={id}
                  declined={declined}
                  connection={connection}
                  current={current}
                  onCarryOn={onCarryOn}
                />
              ),
              MoreAccess: () => (
                <MoreAccessAction
                  id={id}
                  connection={connection}
                  current={current}
                  onCarryOn={onCarryOn}
                />
              ),
            })}
          </div>
        </div>
      </Card>
    </Edged>
  )
}

/** The line and the answers of a card for kinds of data the Person keeps from Vivid. */
function DeclinedAction({
  id,
  declined,
  connection,
  current,
  onCarryOn,
}: {
  id: string
  declined: Extract<access.Escalation, { readonly _tag: 'Declined' }>
  connection: Option.Option<Connection>
  current: boolean
  onCarryOn: (message: string) => void
}) {
  const named = access.classesSaid(declined.classes)
  // Allowed now when every class the call needed is allowed on the account as it stands live.
  const allowed = Option.exists(connection, (each) =>
    access
      .dataClassesOf(each)
      .every((entry) => !declined.classes.includes(entry.dataClass) || entry.allowed),
  )
  const allow = (each: Connection) =>
    void act(
      orSay(
        Effect.gen(function* () {
          for (const dataClass of declined.classes) {
            const result = yield* changing((client) =>
              client.SetConnectionPermission({ id: each.id, dataClass, decision: 'Allow' }),
            )
            if (Result.isFailure(result)) return result
          }
          // Said for Vivid only once the server has taken every class, and only while the Thread
          // still waits on this card: a card further up is a record, not a question.
          if (current) {
            carriedOn(id)
            onCarryOn(`I allowed ${named} on ${declined.account}. Try again.`)
          }
          return Result.succeed(undefined)
        }),
        `${named} could not be allowed. Try again.`,
      ),
    )
  return (
    <>
      <p role="status" className={cn('text-label', allowed ? 'text-success' : 'text-ink-2')}>
        {allowed ? `${named} allowed` : `You keep ${named} from Vivid here`}
      </p>
      {!allowed && Option.isSome(connection) && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="pill" onClick={() => allow(connection.value)}>
            Allow {named}
          </Button>
          {current && (
            <Button
              size="pill"
              variant="outline"
              onClick={() => {
                carriedOn(id)
                onCarryOn(`Keep ${named} on ${declined.account} out of it.`)
              }}
            >
              Keep them out
            </Button>
          )}
        </div>
      )}
    </>
  )
}

/** The line and the one press of a card for an account that was not given enough. */
function MoreAccessAction({
  id,
  connection,
  current,
  onCarryOn,
}: {
  id: string
  connection: Option.Option<Connection>
  current: boolean
  onCarryOn: (message: string) => void
}) {
  const attempt = useAttempt()
  const standing = standingForCard(attempt, id)
  const keying = keyingFor(attempt, Option.some(id))
  if (Option.isNone(connection)) {
    return <p className="text-label text-ink-2">This account is no longer connected.</p>
  }
  const each = connection.value
  const resume = access.canReconnect(each)
  const said = saidAfter(standing, each.serviceName)
  const card = Option.some({
    id,
    carryOn: (back: Connection) => {
      if (current) onCarryOn(`${back.account} has the access now. Try again.`)
    },
  })
  const signIn = () =>
    press(
      resume
        ? {
            pressed: each.id,
            asked: connecting.Asked.cases.Resume.make({ id: each.id }),
            signIn: false,
            card,
          }
        : {
            pressed: each.service,
            asked: connecting.Asked.cases.Begin.make({
              service: each.service,
              shared: false,
              name: Option.fromNullOr(each.name),
            }),
            signIn: true,
            card,
          },
    )
  return (
    <>
      <p role="status" className="text-label text-pretty text-ink-2">
        {Option.match(said, {
          onNone: () => 'Needs more access than it was given',
          onSome: (line) => line.words,
        })}
      </p>
      <div className="mt-2">
        <Button size="pill" disabled={waitingOn(attempt)} onClick={signIn}>
          {resume ? 'Reconnect' : 'Sign in again'}
        </Button>
      </div>
      {Option.isSome(keying) && (
        <div className="pt-2">
          <EnterKey keying={keying.value} onClose={dismiss} onAnswered={finish} />
        </div>
      )}
    </>
  )
}

/** Finds the record a card stands for among what the Thread carries. */
export const approvalById = (approvals: ReadonlyArray<Approval>, id: ApprovalId) =>
  Option.fromUndefinedOr(approvals.find((approval) => approval.id === id))

export const requestById = (requests: ReadonlyArray<InputRequest>, id: InputRequestId) =>
  Option.fromUndefinedOr(requests.find((request) => request.id === id))

/** The step a card stands for, from the Thread's record of its handoffs. */
export const handoffById = (handoffs: ReadonlyArray<HandoffRequest>, id: HandoffId) =>
  Option.fromUndefinedOr(handoffs.find((handoff) => handoff.id === id))
