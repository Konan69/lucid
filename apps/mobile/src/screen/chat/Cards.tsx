import { ApprovalState, type Approval, type PersonId, type ThreadDetail } from '@vivid/contracts'
import { Option } from 'effect'
import { changedLine } from '@vivid/state'
import { View } from 'react-native'
import type { Say } from '../../data/delivery'
import { Card, cardOf, type ToolPart } from '../../data/message'
import { Label } from '../../ui/ui'
import { IntegrationCard } from '../integration/Card'
import { approvalOf, requestOf } from './asked'
import { Asked } from './Question'
import { Words } from './Words'

/**
 * What a Thread shows where a tool's result names a record: something Vivid wants to do and
 * needs a yes for, a question it could not answer alone, a service it needs connected. Each is
 * drawn from the server's record in the Thread's live detail, so it keeps telling the truth
 * after it is settled: who allowed it, what came back, or that it ran out.
 *
 * Only a service to connect is a card. What Vivid asks of the Person is drawn as Vivid's own
 * words, and the way to answer rises from behind the composer: a question (`Asked`,
 * `Question.tsx`; `Choices.tsx`) and an Approval (`AskedFirst`; `Allow.tsx`).
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
    return Option.match(cardOf(tool), {
      onNone: () => null,
      onSome: (card) => (
        // A card stands a little apart from the words round it. What Vivid asks is words itself.
        <View key={tool.toolCallId} style={Card.$is('Connection')(card) ? CARD_ROOM : undefined}>
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

/**
 * One of them. An Approval and an Input request are drawn from their record, never from the
 * tool's own words; until that record has arrived in the Thread's detail there is nothing
 * truthful to draw, so nothing is drawn.
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
        onSome: (approval) => <AskedFirst approval={approval} me={me} />,
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
    Invalidated: ({ reason }) => (
      <Label size="label" tone="ink-2">
        {changedLine(reason)}
      </Label>
    ),
  })
}

/**
 * Something Vivid asked before doing it, where the card was: Vivid's words, as a question's are
 * (`Asked`, `Question.tsx`). A quiet line says what these words are, then the action's summary
 * as an ordinary message, and under it one line: how it ended once it is settled, or, while it
 * waits on somebody else, who. One waiting on this Person says nothing more here: the way to
 * answer is the banner over the composer (`Allow.tsx`), which also holds exactly what would be
 * done.
 *
 * Until 12 October 2026 this was a card in the conversation with the action's rationale, an
 * effect chip, the whole action and three buttons. The owner rejected it ("too much card
 * nesting, too much unnecessary text"): the conversation reads as a conversation, and what must
 * be pressed is where the thumb already is.
 */
function AskedFirst({ approval, me }: { approval: Approval; me: PersonId }) {
  const theirs = ApprovalState.guards.Pending(approval.state) && approval.askedOf.id !== me
  return (
    // A little apart from whatever Vivid said before asking.
    <View style={{ marginTop: 8, gap: 2 }}>
      <Label size="caption" tone="ink-3">
        Asked first
      </Label>
      <Words text={approval.action.summary} />
      <ApprovalOutcome state={approval.state} />
      {theirs && (
        <Label size="label" tone="ink-2">
          Waiting on {approval.askedOf.name}.
        </Label>
      )}
    </View>
  )
}
