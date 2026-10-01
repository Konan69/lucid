import {
  ActionTarget,
  ApprovalDecision,
  ApprovalState,
  ConnectionState,
  InputRequestState,
  type Approval,
  type ApprovalId,
  type ConnectionRequestMessage,
  type InputRequest,
  type InputRequestId,
  type PersonId,
  type ThreadDetail,
} from '@vivid/contracts'
import { Option, Result } from 'effect'
import { useState, type ReactNode } from 'react'
import { Linking, View } from 'react-native'
import { Check, Globe, Link2, ShieldQuestion, Terminal, type LucideIcon } from 'lucide-react-native'
import { commit, confirm, warn } from '../../data/haptics'
import { useLiveData, useLiveValue } from '../../data/live'
import { Card, cardOf, type ToolPart } from '../../data/message'
import { connectionsAddress } from '../../data/server'
import { useTheme } from '../../theme'
import { ServiceMark } from '../../ui/Mark'
import { Button, Dot, Field, HAIRLINE, Label, Notice, Press, radius, styles } from '../../ui/ui'

/**
 * The cards a Thread shows where a plain message will not do: something Vivid wants to do and
 * needs a yes for, a question it could not answer alone, a service it needs connected, something
 * it took on. Each card is drawn from the server's record in the Thread's live detail, so it
 * keeps telling the truth after it is settled: who allowed it, what came back, or that it ran out.
 */
export function Cards({
  tools,
  detail,
  me,
  onContinue,
}: {
  tools: ReadonlyArray<ToolPart>
  detail: Option.Option<ThreadDetail>
  me: PersonId
  onContinue: (text: string) => void
}) {
  return tools.map((tool) =>
    Option.match(cardOf(tool), {
      onNone: () => null,
      onSome: (card) => (
        <View key={tool.toolCallId} style={{ marginTop: 8, marginBottom: 6 }}>
          <Drawn card={card} detail={detail} me={me} onContinue={onContinue} />
        </View>
      ),
    }),
  )
}

/** The Approval a card stands for, once the Thread's live detail carries it. */
const approvalOf = (detail: Option.Option<ThreadDetail>, id: ApprovalId) =>
  Option.flatMap(detail, (value) =>
    Option.fromUndefinedOr(value.approvals.find((approval) => approval.id === id)),
  )

/** The Input request a card stands for, once the Thread's live detail carries it. */
const requestOf = (detail: Option.Option<ThreadDetail>, id: InputRequestId) =>
  Option.flatMap(detail, (value) =>
    Option.fromUndefinedOr(value.requests.find((request) => request.id === id)),
  )

/**
 * One card. An Approval and an Input request are drawn from their record, never from the tool's
 * own words; until that record has arrived in the Thread's detail there is nothing truthful to
 * draw, so nothing is drawn.
 */
function Drawn({
  card,
  detail,
  me,
  onContinue,
}: {
  card: Card
  detail: Option.Option<ThreadDetail>
  me: PersonId
  onContinue: (text: string) => void
}) {
  return Card.$match(card, {
    Approval: ({ id }) =>
      Option.match(approvalOf(detail, id), {
        onNone: () => null,
        onSome: (approval) => <ApprovalCard approval={approval} me={me} />,
      }),
    Input: ({ id }) =>
      Option.match(requestOf(detail, id), {
        onNone: () => null,
        onSome: (request) => <InputCard request={request} me={me} />,
      }),
    Connection: ({ request }) => <ConnectionCard request={request} onContinue={onContinue} />,
    Tracked: ({ title, waitingOn }) => <TrackedCard title={title} waitingOn={waitingOn} />,
  })
}

/** The shape every card shares: a quiet raised surface with a small line saying what it is. */
function Shell({
  icon,
  kind,
  tone,
  children,
}: {
  icon: ReactNode
  kind: string
  tone: 'status-approve' | 'status-attention' | 'ink-3'
  children: ReactNode
}) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        padding: 14,
        gap: 8,
        borderRadius: radius.card,
        borderWidth: HAIRLINE,
        borderColor: c['line-3'],
        backgroundColor: c['surface-2'],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon}
        <Label size="caption" tone={tone}>
          {kind}
        </Label>
      </View>
      {children}
    </View>
  )
}

const TARGET_ICON = {
  Connection: Link2,
  Command: Terminal,
  Browser: Globe,
} as const satisfies Record<ActionTarget['_tag'], LucideIcon>

/** Where the action would happen, in a few words. */
const targetLine = (target: ActionTarget) =>
  ActionTarget.match(target, {
    Connection: ({ account, tool }) => `${account} · ${tool}`,
    Command: ({ command }) => command,
    Browser: () => 'In the browser on Vivid’s computer',
  })

/** How an Approval that is no longer waiting ended, in a sentence and the color of its outcome. */
function ApprovalOutcome({ state }: { state: ApprovalState }) {
  return ApprovalState.match(state, {
    Pending: () => null,
    Executing: ({ decidedBy }) => (
      <Label size="label" tone="status-working">
        Allowed by {decidedBy.name}. Doing it now…
      </Label>
    ),
    Succeeded: ({ decidedBy }) => (
      <Label size="label" tone="status-success">
        Done. Allowed by {decidedBy.name}.
      </Label>
    ),
    Failed: ({ reason }) => (
      <Label size="label" tone="status-danger">
        It did not work: {reason}
      </Label>
    ),
    OutcomeUnknown: () => (
      <Label size="label" tone="status-attention">
        Vivid cannot tell whether this happened. Check before trying again.
      </Label>
    ),
    Denied: ({ decidedBy }) => (
      <Label size="label" tone="ink-3">
        Not allowed by {decidedBy.name}.
      </Label>
    ),
    Expired: () => (
      <Label size="label" tone="ink-3">
        This request ran out.
      </Label>
    ),
    Withdrawn: () => (
      <Label size="label" tone="ink-3">
        Withdrawn.
      </Label>
    ),
  })
}

/**
 * One thing Vivid wants to do and will not do without a yes. Only the Person it is addressed to
 * sees the buttons; everyone else in the Thread sees who it is waiting on. The decision quotes
 * the digest of exactly what is shown, so a card drawn from an older proposal cannot allow a
 * newer one. The phone answers a yes and a no differently in the hand as well as on screen.
 */
function ApprovalCard({ approval, me }: { approval: Approval; me: PersonId }) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const [refused, setRefused] = useState(false)
  const pending = ApprovalState.guards.Pending(approval.state)
  const mine = approval.askedOf.id === me
  const Target = TARGET_ICON[approval.action.target._tag]

  async function decide(decision: ApprovalDecision) {
    if (ApprovalDecision.guards.Deny(decision)) warn()
    else confirm()
    setRefused(false)
    const result = await data.change((client) =>
      client.DecideApproval({ id: approval.id, digest: approval.digest, decision }),
    )
    setRefused(Result.isFailure(result))
  }

  return (
    <Shell
      icon={<ShieldQuestion size={14} strokeWidth={1.8} color={c['status-approve']} />}
      kind={pending ? 'Vivid is asking first' : 'Vivid asked first'}
      tone="status-approve"
    >
      <Label size="footnote" style={{ fontSize: 15 }}>
        {approval.action.summary}
      </Label>
      {approval.action.rationale.length > 0 && (
        <Label size="label" tone="ink-3">
          {approval.action.rationale}
        </Label>
      )}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 8,
          // The card's radius less its padding, so the two corners share a centre.
          borderRadius: radius.card - 10,
          backgroundColor: c['surface-well'],
        }}
      >
        <Target size={15} strokeWidth={1.7} color={c['ink-3']} />
        <Label numberOfLines={2} size="label" tone="ink-2" style={{ flex: 1 }}>
          {targetLine(approval.action.target)}
        </Label>
      </View>
      {!pending && <ApprovalOutcome state={approval.state} />}
      {pending && !mine && (
        <Label size="label" tone="ink-3">
          Waiting on {approval.askedOf.name}.
        </Label>
      )}
      {pending && mine && (
        <View style={[styles.wrap, { marginTop: 2 }]}>
          <Button
            kind="primary"
            label="Allow once"
            onPress={() => void decide(ApprovalDecision.cases.AllowOnce.make({}))}
          />
          <Button
            label="Always allow"
            onPress={() => void decide(ApprovalDecision.cases.AlwaysAllow.make({}))}
          />
          <Button
            kind="ghost"
            label="Don’t"
            onPress={() => void decide(ApprovalDecision.cases.Deny.make({}))}
          />
        </View>
      )}
      {refused && <Notice message="This was already decided, or it changed. Look again." />}
    </Shell>
  )
}

/** Where a question stands: waiting on someone, answered and by whom, or no longer needed. */
function Standing({ request, mine }: { request: InputRequest; mine: boolean }) {
  return InputRequestState.match(request.state, {
    Waiting: () =>
      mine ? (
        <Answering request={request} />
      ) : (
        <Label size="label" tone="ink-3">
          Waiting on {request.askedOf.name}.
        </Label>
      ),
    Answered: ({ answeredBy, answer }) => (
      <Label size="label" tone="ink-2">
        <Label size="label" tone="ink-3">{`${answeredBy.name} said: `}</Label>
        {answer}
      </Label>
    ),
    Withdrawn: () => (
      <Label size="label" tone="ink-3">
        No longer needed.
      </Label>
    ),
  })
}

/**
 * A question Vivid could not answer alone. The Person it is addressed to picks an option or
 * writes their own answer; once answered, the card says what was said and by whom.
 */
function InputCard({ request, me }: { request: InputRequest; me: PersonId }) {
  const mine = request.askedOf.id === me
  return (
    <Shell
      icon={<Dot tone="status-attention" size={6} />}
      kind={InputRequestState.guards.Waiting(request.state) ? 'Vivid needs you' : 'Vivid asked'}
      tone="status-attention"
    >
      <Label size="footnote" style={{ fontSize: 15 }}>
        {request.question}
      </Label>
      <Standing request={request} mine={mine} />
    </Shell>
  )
}

/** The options and the free answer, for the Person the question is addressed to. */
function Answering({ request }: { request: InputRequest }) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const [own, setOwn] = useState('')
  const [refused, setRefused] = useState(false)

  async function answer(text: string) {
    const body = text.trim()
    if (body.length === 0) return
    commit()
    setRefused(false)
    const result = await data.change((client) =>
      client.AnswerInput({ id: request.id, answer: body }),
    )
    setRefused(Result.isFailure(result))
  }

  return (
    <View style={{ gap: 8 }}>
      {request.options.map((option) => (
        <Press
          key={option.label}
          accessibilityRole="button"
          onPress={() => void answer(option.label)}
          style={({ pressed }) => ({
            minHeight: 44,
            paddingHorizontal: 12,
            paddingVertical: 9,
            justifyContent: 'center',
            borderRadius: radius.card - 6,
            borderWidth: HAIRLINE,
            borderColor: c['line-3'],
            backgroundColor: pressed ? c['wash-pressed'] : c['surface-3'],
          })}
        >
          <Label size="footnote">{option.label}</Label>
          {option.detail.length > 0 && (
            <Label size="label" tone="ink-3">
              {option.detail}
            </Label>
          )}
        </Press>
      ))}
      {request.allowsOwnAnswer && (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <Field
            accessibilityLabel="Your answer"
            value={own}
            placeholder="Or say it your way"
            multiline
            onChangeText={setOwn}
            style={{ flex: 1, minHeight: 44, paddingVertical: 10, backgroundColor: c['surface-3'] }}
          />
          <Button
            kind="primary"
            label="Answer"
            disabled={own.trim().length === 0}
            onPress={() => void answer(own)}
          />
        </View>
      )}
      {refused && <Notice message="That answer did not go through. It may already be answered." />}
    </View>
  )
}

/**
 * Vivid needs a service connected to go on. The card says why in Vivid's own words. A service is
 * authorized in a browser, so the card opens Vivid's Connections there; whether it is connected
 * is read live, so the card turns to "Carry on" by itself when the Person comes back.
 */
function ConnectionCard({
  request,
  onContinue,
}: {
  request: ConnectionRequestMessage
  onContinue: (message: string) => void
}) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const connections = useLiveValue(data.live.connections)
  const connected = Option.exists(connections, (value) =>
    value.connections.some(
      (connection) =>
        connection.service === request.service && ConnectionState.guards.Ready(connection.state),
    ),
  )
  const ready = request.ready || connected
  return (
    <View
      style={{
        padding: 12,
        gap: 12,
        borderRadius: radius.card,
        borderWidth: HAIRLINE,
        borderColor: c['line-3'],
        backgroundColor: c['surface-2'],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <ServiceMark service={request.service} size={32} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label numberOfLines={1} size="footnote">
            {request.serviceName}
          </Label>
          <Label size="label" tone="ink-3">
            {request.reason}
          </Label>
        </View>
      </View>
      {ready ? (
        <Button
          kind="primary"
          label="Carry on"
          onPress={() => onContinue(`${request.serviceName} is connected. Carry on.`)}
        />
      ) : (
        <Button
          icon={Link2}
          label="Connect in your browser"
          onPress={() => void Linking.openURL(connectionsAddress(data.session.server))}
        />
      )}
    </View>
  )
}

/** A Task Vivid took on, shown where it was agreed. */
function TrackedCard({ title, waitingOn }: { title: string; waitingOn: Option.Option<string> }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        padding: 12,
        borderRadius: radius.card,
        borderWidth: HAIRLINE,
        borderColor: c['line-2'],
        backgroundColor: c['surface-2'],
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          alignItems: 'center',
          justifyContent: 'center',
          // The card's radius less its padding.
          borderRadius: radius.card - 12,
          backgroundColor: c['accent-soft'],
        }}
      >
        <Check size={16} strokeWidth={2} color={c['accent-ink']} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label size="caption" tone="ink-3">
          Vivid is tracking this
        </Label>
        <Label numberOfLines={2} size="footnote">
          {title}
        </Label>
        {Option.isSome(waitingOn) && (
          <Label size="caption" tone="ink-3">
            Waiting on {waitingOn.value}
          </Label>
        )}
      </View>
    </View>
  )
}
