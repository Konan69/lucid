import {
  ApprovalDecision,
  ApprovalState,
  type Approval,
  type ApprovalId,
  type PersonId,
  type ThreadDetail,
} from '@vivid/contracts'
import { APPROVAL_EFFECT_WORDS, drawn, readShown } from '@vivid/state'
import { Option, Result } from 'effect'
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { ShieldQuestion } from 'lucide-react-native'
import type { Say } from '../../data/delivery'
import { confirm, warn } from '../../data/haptics'
import { useLiveData } from '../../data/live'
import { Card, cardOf, type ToolPart } from '../../data/message'
import { useAppearance } from '../../data/vivid'
import { useTheme } from '../../theme'
import { Button, EDGE, Label, Notice, radius, styles } from '../../ui/ui'
import { IntegrationCard } from '../integration/Card'
import { Exactly } from './Exactly'
import { requestOf } from './asked'
import { Asked } from './Question'
import { Display } from './Shown'

/**
 * The cards a Thread shows where a plain message will not do: something Vivid wants to do and
 * needs a yes for, a service it needs connected, something it took on. Each card is drawn from
 * the server's record in the Thread's live detail, so it keeps telling the truth after it is
 * settled: who allowed it, what came back, or that it ran out.
 *
 * A question Vivid could not answer alone is found here too, because it reaches the Thread the
 * same way (a tool's result naming a record), but it is not a card: it is drawn as Vivid's own
 * words (`Asked`, `Question.tsx`), and its choices rise from behind the composer (`Choices.tsx`).
 */
export function Cards({
  tools,
  detail,
  me,
  onContinue,
  live,
}: {
  tools: ReadonlyArray<ToolPart>
  detail: Option.Option<ThreadDetail>
  me: PersonId
  /** Only the newest reply is answerable, once Vivid has stopped working. */
  live: boolean
  onContinue: Say
}) {
  return tools.map((tool) => {
    if (drawn(tool)) {
      const shown = readShown(tool.input)
      return Option.isNone(shown) ? null : (
        <Display key={tool.toolCallId} shown={shown.value.show} live={live} onSay={onContinue} />
      )
    }
    return Option.match(cardOf(tool), {
      onNone: () => null,
      onSome: (card) => (
        // A card stands a little apart from the words round it. A question is words itself.
        <View key={tool.toolCallId} style={Card.$is('Input')(card) ? undefined : CARD_ROOM}>
          <Drawn
            call={tool.toolCallId}
            card={card}
            detail={detail}
            me={me}
            live={live}
            onContinue={onContinue}
          />
        </View>
      ),
    })
  })
}

/** The room above and below a card, between it and the reply's words. */
const CARD_ROOM = { marginTop: 8, marginBottom: 6 } as const

/** The Approval a card stands for, once the Thread's live detail carries it. */
const approvalOf = (detail: Option.Option<ThreadDetail>, id: ApprovalId) =>
  Option.flatMap(detail, (value) =>
    Option.fromUndefinedOr(value.approvals.find((approval) => approval.id === id)),
  )

/**
 * One card. An Approval and an Input request are drawn from their record, never from the tool's
 * own words; until that record has arrived in the Thread's detail there is nothing truthful to
 * draw, so nothing is drawn.
 */
function Drawn({
  call,
  card,
  detail,
  me,
  live,
  onContinue,
}: {
  /** The tool call this card stands for, which is what names its one "carry on". */
  call: string
  card: Card
  detail: Option.Option<ThreadDetail>
  me: PersonId
  /** Whether this is the newest reply and Vivid has stopped: only then is a card still asking. */
  live: boolean
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
        onSome: (request) => <Asked request={request} me={me} />,
      }),
    Connection: ({ request, authorization, awaited }) => (
      <IntegrationCard
        id={call}
        request={request}
        authorization={authorization}
        awaited={awaited}
        current={live}
        onContinue={onContinue}
      />
    ),
  })
}

/** The shape every card shares: a quiet raised surface with a small line saying what it is. */
function Shell({
  icon,
  kind,
  tone,
  trailing,
  children,
}: {
  icon: ReactNode
  kind: string
  tone: 'status-approve' | 'status-attention' | 'ink-3'
  /** Only Approval headers carry an effect chip. */
  trailing?: ReactNode
  children: ReactNode
}) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        padding: 14,
        gap: 8,
        borderRadius: radius.card,
        borderWidth: EDGE,
        borderColor: c.border,
        backgroundColor: c.subtle,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon}
        <Label size="caption" tone={tone} style={{ flex: 1 }}>
          {kind}
        </Label>
        {trailing}
      </View>
      {children}
    </View>
  )
}

/** The web's informational, approval and destructive chip colours, read from native tokens. */
const EFFECT = {
  read: { fill: 'status-info-soft', ink: 'status-info' },
  write: { fill: 'status-approve-soft', ink: 'status-approve' },
  destructive: { fill: 'status-danger-soft', ink: 'status-danger' },
} as const satisfies Record<Approval['action']['effect'], { fill: string; ink: string }>

/** The effect is visible before a decision, and remains part of the settled card's record. */
function EffectChip({ effect }: { effect: Approval['action']['effect'] }) {
  const { colors: c } = useTheme()
  const paint = EFFECT[effect]
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: radius.panel,
        backgroundColor: c[paint.fill],
      }}
    >
      <Label size="caption" style={{ color: c[paint.ink] }}>
        {APPROVAL_EFFECT_WORDS[effect]}
      </Label>
    </View>
  )
}

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
      <Label size="label" tone="ink-2">
        Not allowed by {decidedBy.name}.
      </Label>
    ),
    Expired: () => (
      <Label size="label" tone="ink-2">
        This request ran out.
      </Label>
    ),
    Withdrawn: () => (
      <Label size="label" tone="ink-2">
        Withdrawn.
      </Label>
    ),
  })
}

/**
 * One thing Vivid wants to do and will not do without a yes. Only the Person it is addressed to
 * sees the buttons; everyone else in the Thread sees who it is waiting on. The decision quotes
 * the digest of exactly what is shown, so a card drawn from an older proposal cannot allow a
 * newer one; that is also why everything the digest covers is on the card (`Exactly`) before the
 * buttons are. The phone answers a yes and a no differently in the hand as well as on screen.
 */
function ApprovalCard({ approval, me }: { approval: Approval; me: PersonId }) {
  // The name this Person or their Company gave Vivid, live.
  const vivid = useAppearance()
  const data = useLiveData()
  const { colors: c } = useTheme()
  const [refused, setRefused] = useState(false)
  const pending = ApprovalState.guards.Pending(approval.state)
  const mine = approval.askedOf.id === me

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
      kind={pending ? `${vivid.name} is asking first` : `${vivid.name} asked first`}
      tone="status-approve"
      trailing={<EffectChip effect={approval.action.effect} />}
    >
      <Label size="footnote" style={{ fontSize: 15 }}>
        {approval.action.summary}
      </Label>
      {approval.action.rationale.length > 0 && (
        <Label size="label" tone="ink-2">
          {approval.action.rationale}
        </Label>
      )}
      <Exactly target={approval.action.target} />
      {pending && mine && (
        <Label size="caption" tone="ink-2">
          Your answer applies only to what is shown above.
        </Label>
      )}
      {!pending && <ApprovalOutcome state={approval.state} />}
      {pending && !mine && (
        <Label size="label" tone="ink-2">
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
