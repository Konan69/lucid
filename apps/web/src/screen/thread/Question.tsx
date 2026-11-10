import { InputRequestState, type InputRequest, type PersonId } from '@vivid/contracts'
import { form } from '@vivid/state'
import { Option } from 'effect'
import { Markdown } from '../../ui/Markdown'

/**
 * A request from Vivid (an Input request, of one to four questions), as the Thread's
 * conversation holds it. It is two ordinary messages and nothing else:
 *
 * - The questions are Vivid's words, drawn as its words are anywhere (`Asked`, here), in the
 *   reply that asked them and beside the same face: each question a paragraph of its own.
 * - The answers, once there are any, are the bubble of whoever gave them (`Replied`,
 *   `Message.tsx`), as if they had typed it: a row of the Thread in its own right, where it was
 *   given (`asking.linesOf`, `@vivid/state`), with one line for each question.
 *
 * The ways to answer are not in the conversation. While the request waits on the Person looking
 * at it, its questions are a banner attached to the composer (`Choices.tsx`). A reply
 * from the composer is an ordinary message, which withdraws the request: nothing is added here
 * for a withdrawn request, because that reply is already its own message.
 *
 * Until 11 October 2026 the web drew a question as a card in the conversation: "Vivid needs
 * you", lettered rows in a bordered list, a field for words of one's own, and, once settled, a
 * card that listed the answers or said "No longer needed." The phone had already replaced that
 * with this (`apps/mobile/src/screen/chat/Question.tsx`): the conversation reads as a
 * conversation, and what must be pressed is at the composer.
 */

/**
 * The questions, where the card was: Vivid's words, a paragraph for each. A request waiting on
 * somebody else says who under them, since nothing else on this Person's screen does; one
 * waiting on this Person, answered or withdrawn says nothing more here.
 */
export function Asked({ request, me }: { request: InputRequest; me: PersonId }) {
  return (
    <div className="mt-3">
      <Markdown content={request.questions.map((asked) => asked.question).join('\n\n')} />
      <Ending request={request} me={me} />
    </div>
  )
}

/**
 * The one quiet line under the questions, when there is one: who a request waits on when it is
 * somebody else, and that an Integration's question ran out before anyone answered it.
 */
function Ending({ request, me }: { request: InputRequest; me: PersonId }) {
  const words = InputRequestState.guards.Waiting(request.state)
    ? Option.some(`Waiting on ${request.askedOf.name}.`).pipe(
        Option.filter(() => request.askedOf.id !== me),
      )
    : form.expiredLine(request)
  return Option.match(words, {
    onNone: () => null,
    onSome: (line) => <p className="mt-1 text-label text-ink-3">{line}</p>,
  })
}
