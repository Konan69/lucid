import {
  InputRequestState,
  type InputRequest,
  type PersonId,
  type ThreadDetail,
} from '@vivid/contracts'
import { Option } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { Card, cardOf, type ToolPart } from '../../data/message'
import { SAID } from '../../ui/motion/morph'
import { Label } from '../../ui/ui'
import { requestOf } from './asked'
import { Said, Voice } from './Said'
import { Words } from './Words'

/**
 * A question from Vivid (an Input request), as the Thread's conversation holds it. It is two
 * ordinary messages and nothing else:
 *
 * - The question is Vivid's words, drawn as its words are anywhere (`Asked`), in the reply that
 *   asked it and beside the same face.
 * - The answer, once there is one, is the bubble of whoever gave it (`Replied`), as if they had
 *   typed it.
 *
 * The ways to answer are not in the conversation. While the question waits on the Person looking
 * at it, its choices are a card that rises from behind the composer (`Choices.tsx`), and the
 * composer itself takes words of their own.
 *
 * Until 10 October 2026 a question was a card in the conversation: a title, lettered rows, a row
 * that opened a field for words of one's own, and, once answered, the card closed down to the
 * chosen row with a check. The owner approved its replacement from a prototype: the conversation
 * reads as a conversation, and what must be pressed is where the thumb already is.
 */

/**
 * The question, where the card was: Vivid's words. A question waiting on somebody else says who
 * under it, since nothing else on this Person's screen does; one waiting on this Person, answered
 * or withdrawn says nothing more here.
 */
export function Asked({ request, me }: { request: InputRequest; me: PersonId }) {
  const theirs = InputRequestState.guards.Waiting(request.state) && request.askedOf.id !== me
  return (
    <View>
      <Words text={request.question} />
      {theirs && (
        <Label size="label" tone="ink-2">
          Waiting on {request.askedOf.name}.
        </Label>
      )}
    </View>
  )
}

/**
 * The answers to the questions one reply of Vivid's asked, each as a row of the Thread after
 * that reply. A reply's tool calls name the requests it raised (`cardOf`); the Thread's live
 * detail has each one's record, and only the record says whether, by whom and with what it was
 * answered.
 */
export function Replies({
  tools,
  detail,
  me,
}: {
  tools: ReadonlyArray<ToolPart>
  detail: Option.Option<ThreadDetail>
  me: PersonId
}) {
  return tools.map((tool) =>
    Option.match(
      Option.flatMap(Option.filter(cardOf(tool), Card.$is('Input')), ({ id }) =>
        requestOf(detail, id),
      ),
      {
        onNone: () => null,
        onSome: (request) => <Replied key={tool.toolCallId} request={request} me={me} />,
      },
    ),
  )
}

/** No pictures: an answer is words. One value, so the bubble is not handed a new list each time. */
const NO_PICTURES = [] as const

/**
 * The answer to one question, as the bubble of the Person who gave it: this Person's own on the
 * right, filled, exactly as a message they typed; somebody else's on the left under their name.
 * A question still waiting, or withdrawn, draws nothing.
 *
 * It rises into place (`SAID`, as a message just sent does) only when the question was still
 * waiting when this row was first drawn, which is when the Person watched it be answered. An
 * answer that was already there when the Thread was opened is drawn whole, like everything else.
 */
function Replied({ request, me }: { request: InputRequest; me: PersonId }) {
  const [watched] = useState(InputRequestState.guards.Waiting(request.state))
  return InputRequestState.match(request.state, {
    Waiting: () => null,
    Withdrawn: () => null,
    Answered: ({ answer, answeredBy }) => (
      <Animated.View entering={watched ? SAID : undefined}>
        <Said
          text={answer}
          pictures={NO_PICTURES}
          voice={
            answeredBy.id === me
              ? Voice.Mine()
              : Voice.Theirs({ name: Option.some(answeredBy.name) })
          }
        />
      </Animated.View>
    ),
  })
}
