import { RuntimeDelivery, SignalCue } from '@vivid/contracts'
import { DeliveryMessage } from './conversation.ts'

/**
 * Every other signal is acted on without words ("do not narrate it"), and a model that read this
 * one the same way loaded the skill and opened with a bare question card: on 5 October 2026 five
 * of twelve first Threads did. The body therefore says who speaks and in what order. It names no
 * skill and no tool: on 21 October 2026 the order to activate the first-conversation skill and
 * then ask cost two extra model steps before the first word, and the model chooses its own tools.
 */
const FIRST_CONVERSATION =
  "This is the Person's first Thread. Nothing has been said yet, so you speak first. Open with your own words to the Person, written as text. Use your tools only when this reply needs them."

/** Private words remain plain user turns; every shared/system signal names its speaker and Run turn. */
export const runtimeMessage = (
  audience: 'private' | 'people' | 'company',
  speaker: string,
  message: DeliveryMessage,
  turn: number,
): RuntimeDelivery => {
  const signal = (cue: SignalCue) =>
    RuntimeDelivery.cases.Signal.make({ envelope: { from: speaker, turn, cue } })
  return DeliveryMessage.match(message, {
    ChannelText: ({ body }) => RuntimeDelivery.cases.Words.make({ body, attachments: [] }),
    Said: ({ body, attachments }) =>
      audience === 'private'
        ? RuntimeDelivery.cases.Words.make({
            body,
            attachments: attachments === undefined ? [] : attachments,
          })
        : signal(SignalCue.cases.Message.make({ body })),
    Signal: ({ cue }) => signal(cue),
    FirstConversation: () => signal(SignalCue.cases.FirstConversation.make({ body: FIRST_CONVERSATION })),
  })
}
