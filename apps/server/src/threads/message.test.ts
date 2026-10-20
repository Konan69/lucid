import { describe, expect, it } from 'vitest'
import { modelDelivery } from '@vivid/agent-runtime'
import { DeliveryScope, PersonId, RuntimeRunRequest, ThreadId } from '@vivid/contracts'
import { DeliveryMessage } from './conversation.ts'
import { flueMessage } from './message.ts'

const marker = '69d8a703-98ad-41e7-a584-390a472a6637'
const scope = DeliveryScope.make({
  acting: PersonId.make('MARK-person'),
})

/**
 * What the server sends for each kind of delivery reaches the model as the runtime renders it,
 * with no identifier and no acting scope in the text. The server owns the delivery shapes, so the
 * check lives here and reads the runtime's renderer through its package entry.
 */
describe('delivery authority outside model text', () => {
  it('renders every server delivery kind without identifiers and keeps authority out of Flue history', () => {
    const messages = [
      DeliveryMessage.cases.Said.make({ body: 'Please review this.' }),
      DeliveryMessage.cases.Signal.make({
        type: 'event',
        body: 'Search the Library and cite every source used.',
        attributes: { name: 'Morning review', watch: marker },
      }),
      DeliveryMessage.cases.Signal.make({
        type: 'approval',
        body: 'The Person approved the action.',
        attributes: { approval: marker, outcome: 'approved' },
      }),
      DeliveryMessage.cases.Signal.make({
        type: 'answer',
        body: 'Use the first draft.',
        attributes: { request: 'MARK-request' },
      }),
    ]
    for (const [index, message] of messages.entries()) {
      const turn = index + 1
      const sent = flueMessage('people', 'Ada', message, turn)
      if (sent.kind !== 'signal' || sent.attributes === undefined)
        expect.fail('Shared deliveries must be signals')
      const request = RuntimeRunRequest.make({
        threadId: ThreadId.make('MARK-thread'),
        idempotencyKey: 'MARK-key',
        type: DeliveryMessage.guards.Said(message) ? 'message' : message.type,
        body: sent.body,
        attributes: sent.attributes,
        turn,
        scope,
      })
      const forwarded = modelDelivery(request)
      expect(JSON.stringify(forwarded)).not.toMatch(
        /MARK-|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu,
      )
      expect(JSON.stringify(forwarded)).not.toContain(marker)
      expect(JSON.stringify(forwarded)).not.toContain('scope')
      expect(forwarded).toMatchObject({
        kind: 'signal',
        body: message.body,
        attributes: { from: 'Ada', turn: String(turn) },
      })
      if (forwarded.kind !== 'signal') expect.fail('Shared delivery lost its signal shape')
      const types = ['message', 'event', 'approval', 'answer']
      expect([forwarded.type, forwarded.tagName]).toEqual([types[index], types[index]])
      if (index === 1)
        expect(forwarded.attributes).toEqual({ from: 'Ada', turn: '2', name: 'Morning review' })
      if (index === 2)
        expect(forwarded.attributes).toEqual({ from: 'Ada', turn: '3', outcome: 'approved' })
    }
  })
})
