import { describe, expect, it } from 'vitest'
import { Option } from 'effect'
import {
  DeliveryScope,
  LibraryFolderId,
  PersonId,
  RuntimeRunRequest,
  ThreadId,
} from '@vivid/contracts'
import { DeliveryMessage } from '../../../../../apps/server/src/threads/conversation.ts'
import { flueMessage } from '../../../../../apps/server/src/threads/message.ts'
import { cachedAuthority, modelDelivery, recordScope } from '../delivery.ts'

const marker = '69d8a703-98ad-41e7-a584-390a472a6637'
const scope = DeliveryScope.make({
  acting: PersonId.make('MARK-person'),
  libraryFolder: LibraryFolderId.make(marker),
})

describe('delivery authority outside model text', () => {
  it('renders every server delivery kind without identifiers and keeps authority out of Flue history', () => {
    const messages = [
      DeliveryMessage.cases.Said.make({ body: 'Please review this.' }),
      DeliveryMessage.cases.Signal.make({
        type: 'schedule',
        body: "Search this Routine's Library folder and cite every source used.",
        attributes: { routine: 'MARK-routine', name: 'Morning review', libraryFolder: marker },
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
      const types = ['message', 'schedule', 'approval', 'answer']
      expect([forwarded.type, forwarded.tagName]).toEqual([types[index], types[index]])
      if (index === 1)
        expect(forwarded.attributes).toEqual({ from: 'Ada', turn: '2', name: 'Morning review' })
      if (index === 2)
        expect(forwarded.attributes).toEqual({ from: 'Ada', turn: '3', outcome: 'approved' })
    }
  })

  it('a render misses after restart; private words still use creator authority without attributes', () => {
    const threadId = ThreadId.make('unprepared-thread')
    const signal = {
      kind: 'signal' as const,
      type: 'schedule',
      body: 'Review.',
      attributes: { turn: '1' },
    }
    expect(cachedAuthority(threadId, signal, Option.none())).toEqual(Option.none())
    expect(
      cachedAuthority(
        threadId,
        { kind: 'user', body: 'Review.' },
        Option.some({ creator: scope.acting, creatorName: 'Ada' }),
      ),
    ).toEqual(Option.some({ acting: { threadId, personId: scope.acting }, folder: Option.none() }))
    recordScope(threadId, 1, scope)
    expect(cachedAuthority(threadId, signal, Option.none())).toEqual(
      Option.some({
        acting: { threadId, personId: scope.acting },
        folder: Option.some(scope.libraryFolder),
      }),
    )
  })
})
