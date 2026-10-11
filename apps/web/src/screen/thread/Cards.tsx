import {
  ActionTarget,
  ApprovalDecision,
  ApprovalId,
  ApprovalState,
  ConnectionAuthorization,
  ConnectionAuthorizationMessage,
  ConnectionRequestMessage,
  type AccountName,
  type Connection,
  InputRequestId,
  type Approval,
  type InputRequest,
  type PersonId,
} from '@vivid/contracts'
import { Data, Effect, Option, Predicate, Result, Schema } from 'effect'
import {
  answered,
  answering,
  APPROVAL_EFFECT_WORDS,
  Awaited,
  awaitedOf,
  awaitedWords,
  browserStep,
  CardPress,
  cardPress,
  connecting,
  desktopStep,
} from '@vivid/state'
import { Check, Globe, Link2, MousePointer2, ShieldQuestion, X } from 'lucide-react'
import { BorderBeam } from 'border-beam'
import { useState, type ReactNode } from 'react'
import { act } from '../../data/app'
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
import { changing, live, useLiveValue } from '../../data/live'
import { openSettings } from '../../router'
import { themeShown, useTheme } from '../../data/theme'
import { Button } from '../../ui/button'
import { Card } from '../../ui/card'
import { cn } from '../../ui/cn'
import { EnterKey } from '../integration/Key'
import { Mark } from '../integration/Mark'
import { NameAccount } from '../integration/Name'

/**
 * The cards a Thread shows where a plain message will not do: something Vivid wants to do and
 * needs a yes for, a service it needs connected, something it took on. A question Vivid could
 * not answer alone is not a card: it is Vivid's words here (`Question.tsx`) and a banner attached
 * to the composer (`Choices.tsx`); this file only reads which request a tool call stands for.
 * Each card is drawn from the server's record, so it keeps telling the truth after it is settled: who allowed it, what came back, or that it ran out.
 */

const decodeApprovalRequest = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal('approval-request'), approvalId: ApprovalId }),
)
const decodeInputRequest = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal('input-request'), requestId: InputRequestId }),
)
const decodeConnectionRequest = Schema.decodeUnknownOption(ConnectionRequestMessage)
// An integration Vivid has already started adding carries what comes next: a sign-in or a key.
const decodeAuthorization = Schema.decodeUnknownOption(ConnectionAuthorizationMessage)
type ConnectionAuthorizationValue = typeof ConnectionAuthorization.Type

/** What a tool's output asks the Thread to draw, when it asks for anything. */
export type CardRequest =
  | { readonly kind: 'approval'; readonly id: ApprovalId }
  | { readonly kind: 'input'; readonly id: InputRequestId }
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
  return Option.map(decodeConnectionRequest(output), (request) => ({
    kind: 'connection',
    request,
    authorization: Option.map(decodeAuthorization(output), (message) => message.authorization),
    awaited: awaitedOf(output),
  }))
}

const TARGET_ICON = {
  Connection: <Link2 className="size-4" />,
  Browser: <Globe className="size-4" />,
  Desktop: <MousePointer2 className="size-4" />,
} satisfies Record<ActionTarget['_tag'], ReactNode>

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
 * Exactly what would be done, in full. An Approval is consent to one specific action, so the card
 * shows that action and not a summary of it: the account it would use and every field as it
 * would be sent (who it goes to, the subject, the whole message), or the whole command. One line
 * cut off with an ellipsis is not something a Person can approve.
 */
function Exactly({ target }: { target: ActionTarget }) {
  if (ActionTarget.guards.Connection(target)) {
    return (
      <div className="mt-3 overflow-hidden rounded-control bg-well ring-line">
        <div className="flex items-start gap-2 px-3 py-2 text-label text-ink-2 hairline-b">
          <span className="mt-0.5 shrink-0 text-ink-3">{TARGET_ICON.Connection}</span>
          {/* In full and wrapping: the account is where the action lands. */}
          <span className="min-w-0 wrap-break-word">
            {target.account} <span className="text-ink-3">· {target.tool}</span>
          </span>
        </div>
        <dl className="flex max-h-72 flex-col gap-2 overflow-y-auto px-3 py-2.5 text-label">
          {fieldsOf(target.input).map(([key, value]) => (
            <div key={key}>
              <dt className="flex items-baseline gap-1.5 text-meta font-meta text-ink-3">
                {fieldName(key)}
                <code className="font-mono">{key}</code>
              </dt>
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
    <div className="mt-3 flex items-start gap-2 rounded-control bg-well px-3 py-2 text-label text-ink-2 ring-line">
      <span className="mt-0.5 shrink-0 text-ink-3">{TARGET_ICON[target._tag]}</span>
      <span className="min-w-0 font-mono wrap-break-word whitespace-pre-wrap">
        {ActionTarget.match(target, {
          Connection: ({ account, tool }) => `${account} · ${tool}`,
          Browser: ({ action }) => browserStep(action),
          Desktop: ({ action }) => desktopStep(action),
        })}
      </span>
    </div>
  )
}

const SETTLED = 'inline-flex items-center gap-1.5 text-label'

/**
 * The edge of a card that has a beam. The beam clips whatever it wraps to its own box, and a
 * card's edge is a shadow that falls just outside that box, so inside a beam the card lost its
 * edge and sat on the light page as white on near-white. The edge is drawn here, outside the
 * beam, at the card's own radius.
 */
function Edged({ children }: { children: ReactNode }) {
  return <div className="mt-3 rounded-card edge">{children}</div>
}

/** How an Approval that is no longer waiting ended, in a sentence. */
function ApprovalOutcome({ state }: { state: ApprovalState }) {
  return ApprovalState.match(state, {
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
    Expired: () => <span className={cn(SETTLED, 'text-ink-3')}>This request ran out.</span>,
    Withdrawn: () => <span className={cn(SETTLED, 'text-ink-3')}>Withdrawn.</span>,
  })
}

/** How much an action can change, said plainly and coloured by how careful to be. */
const EFFECT = {
  read: { words: APPROVAL_EFFECT_WORDS.read, tone: 'bg-info-soft text-info' },
  write: { words: APPROVAL_EFFECT_WORDS.write, tone: 'bg-approve-soft text-approve' },
  destructive: { words: APPROVAL_EFFECT_WORDS.destructive, tone: 'bg-danger-soft text-danger' },
} as const satisfies Record<Approval['action']['effect'], { words: string; tone: string }>

/**
 * One thing Vivid wants to do and will not do without a yes. Only the Person it is addressed to
 * sees the buttons; everyone else in the Thread sees who it is waiting on. The decision quotes the
 * digest of exactly what is shown, so a card drawn from an older proposal cannot allow a newer one.
 */
export function ApprovalCard({ approval, me }: { approval: Approval; me: PersonId }) {
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = ApprovalState.guards.Pending(approval.state)
  const mine = approval.askedOf.id === me
  const shown = useTheme(themeShown)

  function decide(decision: ApprovalDecision) {
    return Effect.gen(function* () {
      setRefusal(null)
      const result = yield* changing((client) =>
        client.DecideApproval({ id: approval.id, digest: approval.digest, decision }),
      )
      if (Result.isFailure(result))
        setRefusal('This was already decided, or it changed. Look again.')
    })
  }

  return (
    // A request waiting on this Person is the one thing in the Thread that needs them, so its
    // edge breathes until they answer. Settled, or someone else's to answer, it is a plain card.
    <Edged>
      <BorderBeam
        active={pending && mine}
        size="pulse-inner"
        colorVariant="mono"
        strength={0.6}
        theme={shown}
      >
        <Card className="block p-4">
          <div className="flex items-center gap-2 text-meta text-approve">
            <ShieldQuestion className="size-3.5" />
            <span className="flex-1">
              {pending ? 'Vivid is asking first' : 'Vivid asked first'}
            </span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 font-title',
                EFFECT[approval.action.effect].tone,
              )}
            >
              {EFFECT[approval.action.effect].words}
            </span>
          </div>
          <h3 className="mt-2 text-title font-title text-ink">{approval.action.summary}</h3>
          {approval.action.rationale.length > 0 && (
            <p className="mt-1 text-label text-ink-3">{approval.action.rationale}</p>
          )}
          <Exactly target={approval.action.target} />
          {pending && mine && (
            <p className="mt-2 text-meta font-meta text-ink-3">
              Your answer applies only to what is shown above.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!pending && <ApprovalOutcome state={approval.state} />}
            {pending && !mine && (
              <span className="text-label text-ink-3">Waiting on {approval.askedOf.name}.</span>
            )}
            {pending && mine && (
              <>
                <Button onClick={() => void act(decide(ApprovalDecision.cases.AllowOnce.make({})))}>
                  Allow once
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void act(decide(ApprovalDecision.cases.AlwaysAllow.make({})))}
                >
                  Always allow
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void act(decide(ApprovalDecision.cases.Deny.make({})))}
                >
                  Don’t
                </Button>
              </>
            )}
          </div>
          {refusal !== null && (
            <p role="alert" className="mt-2 text-label text-danger">
              {refusal}
            </p>
          )}
        </Card>
      </BorderBeam>
    </Edged>
  )
}

/** One sentence the card says under its reason, and whether it is a fault to be read at once. */
interface Said {
  readonly words: string
  readonly urgent: boolean
}

const NOT_STARTED = Option.some<Said>({
  words: 'That did not start. It may not be available on this server yet.',
  urgent: true,
})

/**
 * What the card says under the reason, from where its own attempt stands in the machine
 * (`connecting` in `@vivid/state`), when it says anything. A press that is on its way, a key
 * being asked for and an account that connected are said by the button, the dialog and the live
 * list; only a sign-in in its tab, one the Person came back from without finishing, and an
 * attempt that ended without an account have a sentence. An unfinished sign-in is not a fault
 * (people look at the page and leave), so it is said calmly, by the service's name.
 */
const saidAfter = (standing: connecting.Standing, serviceName: string) =>
  connecting.Standing.match<Option.Option<Said>>(standing, {
    Still: () => Option.none(),
    Starting: () => Option.none(),
    Away: () =>
      Option.some({
        words: 'Finish in the tab that opened. Vivid carries on by itself.',
        urgent: false,
      }),
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
 * Vivid needs a service to go on. One card says which service, why in Vivid's own words, and has
 * one thing to press. The press starts the same attempt Settings makes, right here: a sign-in
 * opens in its own tab, a key is typed into a dialog that sends it straight to the Integration
 * (never into the Thread, never to Vivid). Whether it is connected is read live, so the card
 * settles by itself, and Vivid carries on without being told.
 *
 * Where the attempt stands is not kept by the card. It is in the page's one machine
 * (`data/connecting.ts`), found by the tool call this card stands for, so an answer that comes
 * late cannot write over a newer press and a card drawn again says what the one before it said.
 *
 * Which accounts settle it is `awaited`. A service Vivid offered is settled by any ready account
 * on it. An Integration Vivid began is settled by that one. One more account, which Vivid asks
 * for when the Person wants an account that is not among theirs (their work Gmail), is settled
 * only by an account begun after Vivid asked: the card then says "Add another … account" and
 * offers Connect although the service is already connected.
 */
export function ConnectionCard({
  id,
  request,
  authorization,
  awaited,
  current,
  onContinue,
}: {
  /** The tool call this card stands for, which names its one "carry on". */
  id: string
  request: ConnectionRequestMessage
  authorization: Option.Option<ConnectionAuthorizationValue>
  awaited: Awaited
  /** Whether this is the newest thing in the Thread and Vivid has stopped to wait for it. */
  current: boolean
  onContinue: (message: string) => void
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
        carryOn: (connection) => onContinue(words.carryOn(Option.some(connection))),
      }),
    })

  /**
   * "Carry on" from an attempt that ended without an account the service would take: Vivid is
   * told what happened and decides what to do next. Nothing is owed for it, as for any carry-on
   * made by hand.
   */
  const giveUp = (message: string) => {
    carriedOn(id)
    onContinue(message)
  }

  /** "Carry on" by hand: said with the list as it stands, and no longer owed by an attempt. */
  const carryOn = () => {
    carriedOn(id)
    onContinue(words.carryOn(answering(list, request, awaited)))
  }

  const said = saidAfter(standing, request.serviceName)
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
        <Card className="flex-row flex-wrap items-center gap-3 p-4">
          <Mark service={{ name: request.serviceName }} size={40} />
          <div className="min-w-48 flex-1">
            <h3 className="text-title font-title text-ink">{ready ? words.done : words.connect}</h3>
            <p className="mt-0.5 text-label text-pretty text-ink-3">{request.reason}</p>
            {!ready && Option.isSome(said) && (
              <p
                role={said.value.urgent ? 'alert' : 'status'}
                className={cn(
                  'mt-1.5 text-label text-pretty',
                  said.value.urgent ? 'text-danger' : 'text-working',
                )}
              >
                {said.value.words}
              </p>
            )}
          </div>
          <ConnectionAction
            label={words.connect}
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
          {/* Open exactly while this card's own attempt is waiting for a key. */}
          {Option.isSome(keying) && (
            <EnterKey keying={keying.value} onClose={dismiss} onAnswered={finish} />
          )}
        </Card>
      </BorderBeam>
    </Edged>
  )
}

/** The one thing to press on the card, or the settled fact when there is nothing left to press. */
function ConnectionAction({
  label,
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
  if (ready && current) {
    // Reached when the service was connected somewhere else (Settings, another device), where no
    // press here was owed its carry-on.
    return (
      <Button size="sm" onClick={onCarryOn}>
        Carry on
      </Button>
    )
  }
  if (ready) {
    return (
      <span className={cn(SETTLED, 'text-success')}>
        <Check className="size-3.5" />
        Connected
      </span>
    )
  }
  /** The button at one point of an attempt: what it says, and whether a name is asked first. */
  const says = (words: string) => Offer.Press({ words, naming })
  // What there is to press, from where the card's own attempt stands.
  const offer = connecting.Standing.match<Offer>(standing, {
    Still: () => says('Connect'),
    // Beginning can take the server many seconds; the button says so from the press.
    Starting: () => says('Connecting…'),
    // Once a press is waiting on a sign-in, pressing again opens it again: no second name is
    // asked.
    Away: () => Offer.Press({ words: 'Open it again', naming: Option.none() }),
    Checking: () => says('Connecting…'),
    Keying: () => says('Connect'),
    // The account was begun and is in the list unfinished, so this press picks it up
    // (`cardPress`) and no second name is asked.
    Unfinished: () => Offer.Press({ words: 'Try again', naming: Option.none() }),
    Connected: () => says('Connect'),
    Refused: ({ refusal }) =>
      connecting.Refusal.match<Offer>(refusal, {
        NotBegun: () => Offer.Settings(),
        Blocked: () => says('Connect'),
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
    Press: ({ words, naming }) => (
      <ConnectButton
        says={words}
        label={card.label}
        waiting={card.waiting}
        naming={naming}
        onConnect={card.onConnect}
      />
    ),
    Settings: () => (
      <Button variant="outline" size="sm" onClick={() => void openSettings('connections')}>
        Open Integrations
      </Button>
    ),
    // Offered only while the Thread is waiting on this card: once it has been carried on, the
    // same words must not be sent to Vivid a second time.
    CarryOn: ({ message }) =>
      card.current ? (
        <Button size="sm" onClick={() => card.onGiveUp(message)}>
          Carry on
        </Button>
      ) : null,
  })

/**
 * What a card that is not ready offers to press, from where its own attempt stands.
 *
 * - `Press`: make the attempt (again): what the button says, and whether a name is asked first.
 * - `Settings`: the server would not begin it. It is not pressed again here; Settings is
 *   offered, which says more.
 * - `CarryOn`: the service did not take the key, and the server takes no second one for the
 *   account. Pressing again would pick up an account the server refuses, and replacing it in
 *   Settings would never answer a card that waits for this very account, so the Thread would be
 *   stuck. The card carries the Thread on with `message` instead: Vivid hears what happened and
 *   decides what to do next.
 */
type Offer = Data.TaggedEnum<{
  Press: { readonly words: string; readonly naming: Naming }
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
  waiting,
  naming,
  onConnect,
}: {
  says: string
  label: string
  waiting: boolean
  naming: Naming
  onConnect: (name: Option.Option<AccountName>) => void
}) {
  if (Option.isNone(naming)) {
    return (
      <Button
        size="sm"
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
        <Button size="sm" aria-label={label} disabled={waiting}>
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

/** Finds the record a card stands for among what the Thread carries. */
export const approvalById = (approvals: ReadonlyArray<Approval>, id: ApprovalId) =>
  Option.fromUndefinedOr(approvals.find((approval) => approval.id === id))

export const requestById = (requests: ReadonlyArray<InputRequest>, id: InputRequestId) =>
  Option.fromUndefinedOr(requests.find((request) => request.id === id))
