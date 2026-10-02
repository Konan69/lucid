import {
  ActionTarget,
  ApprovalDecision,
  ApprovalId,
  ApprovalState,
  ConnectionAuthorization,
  ConnectionAuthorizationMessage,
  ConnectionRequestMessage,
  ConnectionState,
  InputRequestId,
  InputRequestState,
  type Approval,
  type InputRequest,
  type PersonId,
} from '@vivid/contracts'
import { Option, Predicate, Result, Schema } from 'effect'
import { browserStep, desktopStep } from '@vivid/state'
import { Check, Globe, Link2, MousePointer2, ShieldQuestion, Terminal, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { change, live, useLiveValue } from '../../data/live'
import { router } from '../../data/route'
import { orSay, say } from '../../data/said'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { cn } from '../../ui/cn'
import { EnterKey, type Keying } from '../integration/Key'
import { showSignIn } from '../integration/signin'

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
  }))
}

const TARGET_ICON = {
  Connection: <Link2 className="size-4" />,
  Command: <Terminal className="size-4" />,
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
          Command: ({ command }) => command,
          Browser: ({ action }) => browserStep(action),
          Desktop: ({ action }) => desktopStep(action),
        })}
      </span>
    </div>
  )
}

const SETTLED = 'inline-flex items-center gap-1.5 text-label'

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

/**
 * One thing Vivid wants to do and will not do without a yes. Only the Person it is addressed to
 * sees the buttons; everyone else in the Thread sees who it is waiting on. The decision quotes the
 * digest of exactly what is shown, so a card drawn from an older proposal cannot allow a newer one.
 */
export function ApprovalCard({ approval, me }: { approval: Approval; me: PersonId }) {
  const [refusal, setRefusal] = useState<string | null>(null)
  const pending = ApprovalState.guards.Pending(approval.state)
  const mine = approval.askedOf.id === me

  async function decide(decision: ApprovalDecision) {
    setRefusal(null)
    const result = await change((client) =>
      client.DecideApproval({ id: approval.id, digest: approval.digest, decision }),
    )
    if (Result.isFailure(result)) setRefusal('This was already decided, or it changed. Look again.')
  }

  return (
    <Card className="mt-3 p-4">
      <div className="flex items-center gap-2 text-meta text-approve">
        <ShieldQuestion className="size-3.5" />
        {pending ? 'Vivid is asking first' : 'Vivid asked first'}
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
            <Button
              variant="primary"
              onClick={() => void decide(ApprovalDecision.cases.AllowOnce.make({}))}
            >
              Allow once
            </Button>
            <Button onClick={() => void decide(ApprovalDecision.cases.AlwaysAllow.make({}))}>
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
  )
}

/**
 * A question Vivid could not answer alone. The Person it is addressed to picks an option or writes
 * their own answer; once answered, the card says what was said and by whom.
 */
export function InputCard({ request, me }: { request: InputRequest; me: PersonId }) {
  const [own, setOwn] = useState('')
  const waiting = InputRequestState.guards.Waiting(request.state)
  const mine = request.askedOf.id === me

  function answer(text: string) {
    const body = text.trim()
    if (body.length === 0) return
    void orSay(
      change((client) => client.AnswerInput({ id: request.id, answer: body })),
      'Your answer did not reach Vivid. Try again.',
    )
  }

  return (
    <Card className="mt-3 p-4">
      <div className="flex items-center gap-2 text-meta text-attention">
        <i className="size-1.5 rounded-full bg-attention" />
        {waiting ? 'Vivid needs you' : 'Vivid asked'}
      </div>
      <h3 className="mt-2 text-title font-title text-ink">{request.question}</h3>
      {InputRequestState.guards.Waiting(request.state) && mine && (
        <Answering request={request} own={own} onOwn={setOwn} onAnswer={answer} />
      )}
      {InputRequestState.guards.Waiting(request.state) && !mine && (
        <p className="mt-2 text-label text-ink-3">Waiting on {request.askedOf.name}.</p>
      )}
      {InputRequestState.guards.Answered(request.state) && (
        <p className="mt-2 text-label text-ink-2">
          <span className="text-ink-3">{request.state.answeredBy.name} said:</span>{' '}
          {request.state.answer}
        </p>
      )}
      {InputRequestState.guards.Withdrawn(request.state) && (
        <p className="mt-2 text-label text-ink-3">No longer needed.</p>
      )}
    </Card>
  )
}

/** The options and the free answer, for the Person the question is addressed to. */
function Answering({
  request,
  own,
  onOwn,
  onAnswer,
}: {
  request: InputRequest
  own: string
  onOwn: (value: string) => void
  onAnswer: (text: string) => void
}) {
  return (
    <>
      <ul className="mt-3 flex flex-col gap-1.5">
        {request.options.map((option) => (
          <li key={option.label}>
            <button
              onClick={() => onAnswer(option.label)}
              className="flex w-full cursor-pointer flex-col rounded-control bg-surface-2 px-3 py-2.5 text-left ring-line transition-colors duration-(--dur-fast) hover:bg-wash-hover"
            >
              <span className="text-label font-title text-ink">{option.label}</span>
              {option.detail.length > 0 && (
                <span className="text-label text-ink-3">{option.detail}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {request.allowsOwnAnswer && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            onAnswer(own)
          }}
        >
          <input
            value={own}
            onChange={(event) => onOwn(event.currentTarget.value)}
            placeholder="Or say it your way"
            className="h-9 min-w-0 flex-1 rounded-control bg-well px-3 text-label text-ink ring-line outline-none placeholder:text-ink-4 focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" variant="primary" disabled={own.trim().length === 0}>
            Answer
          </Button>
        </form>
      )}
    </>
  )
}

/**
 * Vivid needs a service to go on. The card says why in Vivid's own words and finishes the job
 * where the Person already is: a sign-in opens in its own tab, a key is typed into a dialog that
 * sends it straight to the integration (never into the Thread, never to Vivid). Whether it is
 * connected is read live, so the card turns to "Carry on" by itself.
 */
export function ConnectionCard({
  request,
  authorization,
  onContinue,
}: {
  request: ConnectionRequestMessage
  authorization: Option.Option<ConnectionAuthorizationValue>
  onContinue: (message: string) => void
}) {
  const connections = useLiveValue(live.connections)
  const [keying, setKeying] = useState<Option.Option<Keying>>(Option.none())
  const ready =
    request.ready ||
    Option.match(connections, {
      onNone: () => false,
      onSome: (value) =>
        value.connections.some(
          (connection) =>
            ConnectionState.guards.Ready(connection.state) &&
            // The integration Vivid started is this one exactly; a service offered from the
            // catalogue is satisfied by any ready account on it.
            Option.match(authorization, {
              onNone: () => connection.service === request.service,
              onSome: (next) => connection.id === next.connectionId,
            }),
        ),
    })
  return (
    <Card className="mt-3 flex items-center gap-3 p-3">
      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-ink">
        <Link2 className="size-5" strokeWidth={1.6} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-label font-title text-ink">{request.serviceName}</span>
        <span className="block text-label text-ink-3">{request.reason}</span>
      </span>
      {ready ? (
        <Button
          variant="primary"
          size="sm"
          onClick={() => onContinue(`${request.serviceName} is connected. Carry on.`)}
        >
          Carry on
        </Button>
      ) : (
        <Finish
          name={request.serviceName}
          authorization={authorization}
          onKey={(next) => setKeying(Option.some(next))}
        />
      )}
      {Option.isSome(keying) && (
        <EnterKey keying={keying.value} onClose={() => setKeying(Option.none())} />
      )}
    </Card>
  )
}

/** The one thing left to do to connect it: sign in, give it a key, or pick it in Settings. */
function Finish({
  name,
  authorization,
  onKey,
}: {
  name: string
  authorization: Option.Option<ConnectionAuthorizationValue>
  onKey: (keying: Keying) => void
}) {
  if (Option.isNone(authorization)) {
    return (
      <Button size="sm" onClick={() => router.openSettings(Option.some('connections'))}>
        Connect
      </Button>
    )
  }
  return ConnectionAuthorization.match(authorization.value, {
    OpenSignIn: ({ address }) => <SignInButton name={name} address={address} />,
    EnterKey: ({ connectionId, fields }) => (
      <EnterKeyButton connectionId={connectionId} name={name} fields={fields} onKey={onKey} />
    ),
  })
}

/** Opens the authorization address from the initiating click so browser popup rules are met. */
function SignInButton({ name, address }: { name: string; address: string }) {
  return (
    <Button
      size="sm"
      variant="primary"
      onClick={() => {
        if (showSignIn(window.open('about:blank', '_blank'), address)) return
        say(`${name}’s sign-in page could not be opened. Allow pop-ups for this page.`)
      }}
    >
      Sign in
    </Button>
  )
}

/** Opens the key dialog with the fields required by the authorization record. */
function EnterKeyButton({
  connectionId,
  name,
  fields,
  onKey,
}: {
  connectionId: Keying['id']
  name: string
  fields: Keying['fields']
  onKey: (keying: Keying) => void
}) {
  return (
    <Button size="sm" variant="primary" onClick={() => onKey({ id: connectionId, name, fields })}>
      Enter key
    </Button>
  )
}

/** Finds the record a card stands for among what the Thread carries. */
export const approvalById = (approvals: ReadonlyArray<Approval>, id: ApprovalId) =>
  Option.fromUndefinedOr(approvals.find((approval) => approval.id === id))

export const requestById = (requests: ReadonlyArray<InputRequest>, id: InputRequestId) =>
  Option.fromUndefinedOr(requests.find((request) => request.id === id))
