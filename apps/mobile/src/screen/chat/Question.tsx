import type { FlueConversationMessage } from '@flue/sdk'
import {
  InputRequestId,
  InputRequestState,
  type InputRequest,
  type PersonId,
} from '@vivid/contracts'
import { Option, Schema } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import Animated from 'react-native-reanimated'
import { Card, cardOf, momentOf, toolsOf } from '../../data/message'
import { SAID } from '../../ui/motion/morph'
import { Label } from '../../ui/ui'
import { repliedWords, type Spoken } from './asked'
import { Said, Voice } from './Said'
import { Words } from './Words'

/**
 * A request from Vivid (an Input request, of one to four questions), as the Thread's
 * conversation holds it. It is two ordinary messages and nothing else:
 *
 * - The questions are Vivid's words, drawn as its words are anywhere (`Asked`), in the reply
 *   that asked them and beside the same face: each question a paragraph of its own.
 * - The answers, once there are any, are the bubble of whoever gave them (`Replied`), as if they
 *   had typed it: a row of the Thread in its own right, where it was given (`linesOf`,
 *   `asked.ts`), with one line for each question.
 *
 * The ways to answer are not in the conversation. While the request waits on the Person looking
 * at it, its questions are a card that rises from behind the composer (`Choices.tsx`). A reply
 * from the composer is an ordinary message, which withdraws the request: nothing is added here
 * for a withdrawn request, because that reply is already its own message.
 *
 * Until 10 October 2026 a question was a card in the conversation: a title, lettered rows, a row
 * that opened a field for words of one's own, and, once answered, the card closed down to the
 * chosen row with a check. The owner approved its replacement from a prototype: the conversation
 * reads as a conversation, and what must be pressed is where the thumb already is.
 */

/**
 * The questions, where the card was: Vivid's words, a paragraph for each. A request waiting on
 * somebody else says who under them, since nothing else on this Person's screen does; one
 * waiting on this Person, answered or withdrawn says nothing more here.
 */
export function Asked({ request, me }: { request: InputRequest; me: PersonId }) {
  const theirs = InputRequestState.guards.Waiting(request.state) && request.askedOf.id !== me
  return (
    <View>
      <Words text={request.questions.map((asked) => asked.question).join('\n\n')} />
      {theirs && (
        <Label size="label" tone="ink-2">
          Waiting on {request.askedOf.name}.
        </Label>
      )}
    </View>
  )
}

/** Reads a request's identifier from a signal's attribute, which arrives as plain text. */
const decodeRequest = Schema.decodeUnknownOption(InputRequestId)

/**
 * One message of the conversation as placing answers needs it (`linesOf`, `asked.ts`): the
 * requests it raised, when it is a reply of Vivid's that asked (`cardOf`); the request it is the
 * delivered answer to, when it is that signal (the server sends an answer to Vivid as an
 * `answer` signal whose `request` attribute names it, `apps/server/src/inputs/store.ts`); and
 * when it was said, where the conversation stamps it.
 */
export const spokenOf = (message: FlueConversationMessage): Spoken => {
  const signal = message.signal
  const attributes =
    signal === undefined || signal.attributes === undefined ? {} : signal.attributes
  return {
    key: message.id,
    asked: toolsOf(message).flatMap((tool) =>
      Option.toArray(Option.map(Option.filter(cardOf(tool), Card.$is('Input')), ({ id }) => id)),
    ),
    answers:
      signal !== undefined && signal.tagName === 'answer'
        ? decodeRequest(attributes.request)
        : Option.none(),
    at: momentOf(message),
  }
}

/** No pictures: an answer is words. One value, so the bubble is not handed a new list each time. */
const NO_PICTURES = [] as const

/**
 * The answers to one request, as the bubble of the Person who gave them (`repliedWords`): this Person's own on the
 * right, filled, exactly as a message they typed; somebody else's on the left under their name.
 * A question still waiting, or withdrawn, draws nothing.
 *
 * It rises into place (`SAID`, as a message just sent does) only when the question was still
 * waiting when this row was first drawn, which is when the Person watched it be answered. An
 * answer that was already there when the Thread was opened is drawn whole, like everything else.
 */
export function Replied({ request, me }: { request: InputRequest; me: PersonId }) {
  const [watched] = useState(InputRequestState.guards.Waiting(request.state))
  return InputRequestState.match(request.state, {
    Waiting: () => null,
    Withdrawn: () => null,
    Answered: ({ answers, answeredBy }) => (
      <Animated.View entering={watched ? SAID : undefined}>
        <Said
          text={repliedWords(answers)}
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
