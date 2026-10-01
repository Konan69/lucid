import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { ActionTarget, ConnectionId, PersonId, ProposedAction, ThreadId } from '@vivid/contracts'
import { actionDigest } from './action.ts'

const encode = Schema.encodeEffect(ProposedAction)
const person = PersonId.make('person-one')
const thread = ThreadId.make('thread-one')

/** Same invocation with differently ordered nested keys must present the same approval capability. */
it.effect('canonical digests preserve nested meaning and bind Person and Thread', () =>
  Effect.gen(function* () {
    const action = ProposedAction.make({
      summary: 'Update a record',
      rationale: 'Keep it current',
      effect: 'write',
      target: ActionTarget.cases.Connection.make({
        connectionId: ConnectionId.make('connection-one'),
        account: 'Work',
        tool: 'update',
        input: { z: [1, { b: 2, a: 3 }], a: 4 },
      }),
    })
    const reordered = ProposedAction.make({
      ...action,
      target: ActionTarget.cases.Connection.make({
        connectionId: ConnectionId.make('connection-one'),
        account: 'Work',
        tool: 'update',
        input: { a: 4, z: [1, { a: 3, b: 2 }] },
      }),
    })
    const encoded = yield* encode(action)
    const digest = actionDigest(encoded, thread, person)
    expect(digest).toEqual(actionDigest(yield* encode(reordered), thread, person))
    expect(digest).not.toEqual(actionDigest(encoded, ThreadId.make('thread-two'), person))
    expect(digest).not.toEqual(actionDigest(encoded, thread, PersonId.make('person-two')))
    const changed = ProposedAction.make({
      ...action,
      target: ActionTarget.cases.Connection.make({
        connectionId: ConnectionId.make('connection-one'),
        account: 'Other account',
        tool: 'update',
        input: { a: 4, z: [1, { a: 3, b: 2 }] },
      }),
    })
    expect(digest).not.toEqual(actionDigest(yield* encode(changed), thread, person))
    expect(digest).toMatch(/^[a-f0-9]{64}$/u)
  }),
)
