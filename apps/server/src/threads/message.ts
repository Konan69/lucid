import type { RuntimeMessage } from '../runtime/client.ts'
import { DeliveryMessage } from './conversation.ts'

/** The only metadata Flue may render. Project per signal kind rather than forwarding producers' ids. */
export const signalAttributes = (message: DeliveryMessage, speaker: string, turn: number) => {
  if (DeliveryMessage.guards.Signal(message)) {
    // A Watch is named to the model by the name their owner gave them.
    if (message.type === 'event' && message.attributes.name !== undefined)
      return DeliveryMessage.cases.Signal.fields.attributes.make({
        from: speaker,
        turn: String(turn),
        name: message.attributes.name,
      })
    if (message.type === 'approval' && message.attributes.outcome !== undefined)
      return DeliveryMessage.cases.Signal.fields.attributes.make({
        from: speaker,
        turn: String(turn),
        outcome: message.attributes.outcome,
      })
  }
  return DeliveryMessage.cases.Signal.fields.attributes.make({ from: speaker, turn: String(turn) })
}

/** Private words remain plain user turns; every shared/system signal names its speaker and Run turn. */
export const flueMessage = (
  audience: 'private' | 'people' | 'company',
  speaker: string,
  message: DeliveryMessage,
  turn: number,
): RuntimeMessage => {
  const attribution = signalAttributes(message, speaker, turn)
  return DeliveryMessage.match(message, {
    ChannelText: ({ body }): RuntimeMessage => ({ kind: 'user', body, attachments: [] }),
    Said: ({ body, attachments }): RuntimeMessage =>
      audience === 'private'
        ? { kind: 'user', body, attachments: attachments === undefined ? [] : attachments }
        : { kind: 'signal', type: 'message', tagName: 'message', body, attributes: attribution },
    Signal: ({ type, body }): RuntimeMessage => ({
      kind: 'signal',
      type,
      tagName: type,
      body,
      attributes: attribution,
    }),
    FirstConversation: (): RuntimeMessage => ({
      kind: 'signal',
      type: 'first-conversation',
      tagName: 'first-conversation',
      // Every other signal is acted on without words ("do not narrate it"), and a model that
      // reads this one the same way loads the skill and opens with a bare question card: on
      // 5 October 2026 five of twelve first Threads did. The body therefore says who speaks and
      // in what order. It names no skill and no tool: on 21 October 2026 the order to activate
      // the first-conversation skill and then ask cost two extra model steps before the first
      // word, and the model chooses its own tools.
      body: "This is the Person's first Thread. Nothing has been said yet, so you speak first. Open with your own words to the Person, written as text. Use your tools only when this reply needs them.",
      attributes: attribution,
    }),
  })
}
