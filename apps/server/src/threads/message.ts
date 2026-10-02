import type { RuntimeMessage } from '../runtime/client.ts'
import { DeliveryMessage } from './conversation.ts'

/** The only metadata Flue may render. Project per signal kind rather than forwarding producers' ids. */
export const signalAttributes = (message: DeliveryMessage, speaker: string, turn: number) => {
  if (DeliveryMessage.guards.Signal(message)) {
    if (message.type === 'schedule' && message.attributes.name !== undefined)
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
    Said: ({ body }): RuntimeMessage =>
      audience === 'private'
        ? { kind: 'user', body }
        : { kind: 'signal', type: 'message', tagName: 'message', body, attributes: attribution },
    Signal: ({ type, body }): RuntimeMessage => ({
      kind: 'signal',
      type,
      tagName: type,
      body,
      attributes: attribution,
    }),
  })
}
