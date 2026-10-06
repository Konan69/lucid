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
  InputRequestState,
  type Approval,
  type InputRequest,
  type PersonId,
} from '@vivid/contracts'
import { Option, Predicate, Result, Schema } from 'effect'
import {
  answered,
  answering,
  APPROVAL_EFFECT_WORDS,
  asksName,
  Awaited,
  awaitedOf,
  awaitedWords,
  begunFor,
  browserStep,
  desktopStep,
} from '@vivid/state'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import { Check, Globe, Link2, MousePointer2, ShieldQuestion, X } from 'lucide-react'
import { BorderBeam } from 'border-beam'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { change, live, useLiveValue } from '../../data/live'
import { router } from '../../data/route'
import { engine } from '../../data/runtime'
import { orSay } from '../../data/said'
import { theme } from '../../data/theme'
import { Button } from '../../ui/button'
import { Card } from '../../ui/card'
import { cn } from '../../ui/cn'
import { Began, begin, follow } from '../integration/begin'
import { EnterKey, type Keying } from '../integration/Key'
import { Mark } from '../integration/Mark'
import { NameAccount } from '../integration/Name'
import { Asked, Question } from './Question'

/**
 * The cards a Thread shows where a plain message will not do: something Vivid wants to do and
 * needs a yes for, a question it could not answer alone, a service it needs connected, something
 * it took on. Each card is drawn from the server's record, so it keeps telling the truth after it
 * is settled: who allowed it, what came back, or that it ran out.
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
  const shown = useSyncExternalStore(theme.subscribe, theme.shown)

  async function decide(decision: ApprovalDecision) {
    setRefusal(null)
    const result = await change((client) =>
      client.DecideApproval({ id: approval.id, digest: approval.digest, decision }),
    )
    if (Result.isFailure(result)) setRefusal('This was already decided, or it changed. Look again.')
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
                <Button onClick={() => void decide(ApprovalDecision.cases.AllowOnce.make({}))}>
                  Allow once
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void decide(ApprovalDecision.cases.AlwaysAllow.make({}))}
                >
                  Always allow
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void decide(ApprovalDecision.cases.Deny.make({}))}
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

/**
 * A question Vivid could not answer alone. The Person it is addressed to picks an option or writes
 * their own answer; once answered, the card closes down to what was said, and by whom when that
 * was someone else. The card itself is `Question`: this reads the server's record into it.
 */
export function InputCard({ request, me }: { request: InputRequest; me: PersonId }) {
  function answer(text: string) {
    void orSay(
      change((client) => client.AnswerInput({ id: request.id, answer: text })),
      'Your answer did not reach Vivid. Try again.',
    )
  }
  // Each standing is said to be an `Asked`, so the three branches agree on the union and not
  // on whichever one is written first.
  const asked = InputRequestState.match(request.state, {
    Waiting: (): Asked =>
      request.askedOf.id === me
        ? Asked.Open({ onChoose: (choice) => answer(choice.label), onOwn: answer })
        : Asked.Resting({ note: `Waiting on ${request.askedOf.name}.` }),
    Answered: ({ answer: said, answeredBy }): Asked =>
      Asked.Answered({
        answer: said,
        note: answeredBy.id === me ? Option.none() : Option.some(`Answered by ${answeredBy.name}`),
      }),
    Withdrawn: (): Asked => Asked.Resting({ note: 'No longer needed.' }),
  })
  return (
    <div className="mt-3">
      <Question
        status={Option.some(
          InputRequestState.guards.Waiting(request.state) ? 'Vivid needs you' : 'Vivid asked',
        )}
        title={request.question}
        choices={request.options}
        allowsOwn={request.allowsOwnAnswer}
        asked={asked}
      />
    </div>
  )
}

/** How long a card keeps listening for its service after a press before it stops, in ms. */
const LISTEN_MS = 10 * 60_000

// The cards that are listening for their service, so pressing twice does not carry on twice.
const listening = new Set<string>()

/**
 * Carries the Thread on by itself once the service is connected. It is started by the press on
 * the card, not by rendering it: only a Person who just asked to connect wants Vivid to go on
 * the moment the sign-in finishes, and a card read again tomorrow must not speak for them. It
 * listens to the same live list of Connections the card draws from, and gives up after ten
 * minutes, when "Carry on" on the card is still there to press.
 */
function carryOnOnceReady(
  key: string,
  ready: (connections: ReadonlyArray<Connection>) => boolean,
  /** Told the list that settled it, so it can say which account that was. */
  go: (connections: ReadonlyArray<Connection>) => void,
) {
  if (listening.has(key)) return
  listening.add(key)
  const stop = () => {
    listening.delete(key)
    clearTimeout(timer)
    unsubscribe()
  }
  const unsubscribe = engine.registry.subscribe(live.connections.atom, (result) => {
    if (!AsyncResult.isSuccess(result) || !ready(result.value.connections)) return
    stop()
    go(result.value.connections)
  })
  const timer = setTimeout(stop, LISTEN_MS)
}

/** Where a press on the card left things, until the live list says the service is connected. */
type Pressed = 'not-yet' | 'starting' | 'waiting' | 'blocked' | 'refused'

/** What the card says under the reason for each of those, when it says anything. */
const AFTER_PRESS = {
  'not-yet': Option.none(),
  starting: Option.none(),
  waiting: Option.some('Finish in the tab that opened. Vivid carries on by itself.'),
  blocked: Option.some(
    'The sign-in page could not open. Allow pop-ups for this page and try again.',
  ),
  refused: Option.some('That did not start. It may not be available on this server yet.'),
} satisfies Record<Pressed, Option.Option<string>>

/**
 * Vivid needs a service to go on. One card says which service, why in Vivid's own words, and has
 * one thing to press. The press starts the same flow Settings uses, right here: a sign-in opens
 * in its own tab, a key is typed into a dialog that sends it straight to the Integration (never
 * into the Thread, never to Vivid). Whether it is connected is read live, so the card settles by
 * itself, and Vivid carries on without being told.
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
  const [keying, setKeying] = useState<Option.Option<Keying>>(Option.none())
  const [pressed, setPressed] = useState<Pressed>('not-yet')
  const shown = useSyncExternalStore(theme.subscribe, theme.shown)
  const list = Option.match(connections, { onNone: () => [], onSome: (value) => value.connections })
  const readyIn = (all: ReadonlyArray<Connection>) => answered(all, request, awaited)
  // A request for one more account is never ready when it is made, whatever the card was told.
  const ready = (Awaited.$is('Service')(awaited) && request.ready) || readyIn(list)
  const words = awaitedWords(awaited, request.serviceName)
  // Said with the list as it stands when it is said, so one more account is named by the
  // account that was added and Vivid does not have to guess which of several is new.
  const carryOn = (all: ReadonlyArray<Connection>) =>
    onContinue(words.carryOn(answering(all, request, awaited)))
  // One more account on a service that does not say who signs in is named before it is begun,
  // as "Add account" in Settings does; the accounts already there are what show whether it says.
  const held = list.filter((connection) => connection.service === request.service)
  const named = Awaited.$is('Another')(awaited) && asksName(held)

  /** One press: resume what was begun, or begin it, then listen for it to be connected. */
  async function connect(name: Option.Option<AccountName>) {
    // An Integration that was begun and left unfinished is picked up, not begun a second time.
    const begun = begunFor(list, request, awaited)
    // A sign-in tab is opened by the click itself when a sign-in is known to be coming.
    const tab = Option.exists(authorization, ConnectionAuthorization.guards.OpenSignIn)
      ? window.open('about:blank', '_blank')
      : null
    // Beginning can take the server many seconds; the button says so from the press.
    setPressed('starting')
    const began = await Option.match(begun, {
      onNone: () => begin({ id: request.service }, tab, { shared: false, name }),
      onSome: async (connectionId) => {
        const step = await change((client) => client.ResumeConnection({ id: connectionId }))
        if (Result.isSuccess(step)) return follow(step.success, tab)
        if (tab !== null) tab.close()
        return Began.Refused()
      },
    })
    setPressed(
      Began.$match(began, {
        SigningIn: (): Pressed => 'waiting',
        NeedsKey: (): Pressed => 'not-yet',
        Connected: (): Pressed => 'not-yet',
        Blocked: (): Pressed => 'blocked',
        Refused: (): Pressed => 'refused',
      }),
    )
    if (Began.$is('NeedsKey')(began)) setKeying(Option.some(began.keying))
    if (!Began.$is('Blocked')(began) && !Began.$is('Refused')(began)) {
      carryOnOnceReady(id, readyIn, carryOn)
    }
  }

  const after = AFTER_PRESS[pressed]
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
            {!ready && Option.isSome(after) && (
              <p
                role={pressed === 'waiting' ? 'status' : 'alert'}
                className={cn(
                  'mt-1.5 text-label text-pretty',
                  pressed === 'waiting' ? 'text-working' : 'text-danger',
                )}
              >
                {after.value}
              </p>
            )}
          </div>
          <ConnectionAction
            label={words.connect}
            naming={named ? Option.some({ service: request.serviceName, held }) : Option.none()}
            ready={ready}
            current={current}
            pressed={pressed}
            onConnect={(name) => void connect(name)}
            onCarryOn={() => carryOn(list)}
          />
          {Option.isSome(keying) && (
            <EnterKey keying={keying.value} onClose={() => setKeying(Option.none())} />
          )}
        </Card>
      </BorderBeam>
    </Edged>
  )
}

/** What the card's button says at each point; it is the same button and the same press. */
const CONNECT_WORDS = {
  'not-yet': 'Connect',
  starting: 'Connecting…',
  waiting: 'Open it again',
  blocked: 'Connect',
  refused: 'Connect',
} satisfies Record<Pressed, string>

/** The one thing to press on the card, or the settled fact when there is nothing left to press. */
function ConnectionAction({
  label,
  naming,
  ready,
  current,
  pressed,
  onConnect,
  onCarryOn,
}: {
  /** What the press does, for a screen reader: "Connect Gmail", "Add another Gmail account". */
  label: string
  /**
   * The service whose new account is asked a name for before it is begun, when one is, with the
   * accounts already on it: a name one of them has cannot be given again.
   */
  naming: Option.Option<{ readonly service: string; readonly held: ReadonlyArray<Connection> }>
  ready: boolean
  current: boolean
  pressed: Pressed
  onConnect: (name: Option.Option<AccountName>) => void
  onCarryOn: () => void
}) {
  if (ready && current) {
    // Reached when the service was connected somewhere else (Settings, another device), where no
    // press here was listening for it.
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
  if (pressed === 'refused') {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => router.openSettings(Option.some('connections'))}
      >
        Open Integrations
      </Button>
    )
  }
  // Once a press is waiting on a sign-in, pressing again opens it again: no second name is asked.
  if (Option.isSome(naming) && pressed !== 'waiting') {
    return (
      <NameAccount
        trigger={
          <Button size="sm" aria-label={label} disabled={pressed === 'starting'}>
            {CONNECT_WORDS[pressed]}
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
  return (
    <Button
      size="sm"
      aria-label={label}
      disabled={pressed === 'starting'}
      onClick={() => onConnect(Option.none())}
    >
      {CONNECT_WORDS[pressed]}
    </Button>
  )
}

/** Finds the record a card stands for among what the Thread carries. */
export const approvalById = (approvals: ReadonlyArray<Approval>, id: ApprovalId) =>
  Option.fromUndefinedOr(approvals.find((approval) => approval.id === id))

export const requestById = (requests: ReadonlyArray<InputRequest>, id: InputRequestId) =>
  Option.fromUndefinedOr(requests.find((request) => request.id === id))
