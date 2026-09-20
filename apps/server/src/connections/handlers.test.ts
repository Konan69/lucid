import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { ConnectionId, Forbidden, Person, PersonId, SessionId } from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/api'
import { connectionHandlers } from './handlers.ts'
import { ConnectionStore } from './store.ts'

/**
 * A store that fails the test if it is reached. The gate under test must refuse a Person before
 * any provider authority is touched, so every operation here is a defect, not a stub answer.
 */
const unreachable = Effect.die('ConnectionStore must not be reached')
const unreachableStore = ConnectionStore.of({
  list: () => unreachable,
  authorizationUrl: () => unreachable,
  exchangeCode: () => unreachable,
  remove: () => unreachable,
  execute: () => unreachable,
})

const person = AuthState.Person({
  person: Person.make({
    id: PersonId.make('person-1'),
    name: 'Ada',
    email: 'ada@example.test',
  }),
  sessionId: SessionId.make('session-1'),
})

describe('ExecuteConnectionTool', () => {
  it.effect('refuses a Person session so only Vivid acts through a Connection', () =>
    Effect.gen(function* () {
      const failure = yield* connectionHandlers
        .ExecuteConnectionTool({
          connector: ConnectionId.make('gmail'),
          tool: 'send',
          input: {},
        })
        .pipe(
          Effect.provideService(AuthContext, person),
          Effect.provideService(ConnectionStore, unreachableStore),
          Effect.flip,
        )
      expect(failure).toBeInstanceOf(Forbidden)
    }),
  )
})
