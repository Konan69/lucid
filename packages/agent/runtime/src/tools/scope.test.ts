import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { DeliveryScope, LibraryFolderId, PersonId, ThreadId } from '@vivid/contracts'
import { scopeLayer, Scope } from './scope.ts'
import { cachedAuthority, recordScope } from '../delivery.ts'
import { searchRequest } from './library.ts'
import { settle } from './result.ts'

const folder = '3a1c68db-241e-4b59-a0aa-4b18867d6da1'

/** Server scope is decoded independently of model input, with absent and malformed deliveries safe. */
describe('Routine Library authority', () => {
  it('uses only a valid server signal folder and puts it in the search request', () => {
    const threadId = ThreadId.make('scope-test-thread')
    recordScope(
      threadId,
      1,
      DeliveryScope.make({
        acting: PersonId.make('MARK-person'),
        libraryFolder: LibraryFolderId.make(folder),
      }),
    )
    const delivery = {
      kind: 'signal' as const,
      type: 'schedule',
      body: 'Search.',
      attributes: { turn: '1' },
    }
    const decoded = Option.map(
      cachedAuthority(threadId, delivery, Option.none()),
      (scope) => scope.folder,
    )
    expect(decoded).toEqual(Option.some(Option.some(LibraryFolderId.make(folder))))
    expect(searchRequest({ query: 'Sources', limit: 6 }, Option.flatten(decoded))).toEqual({
      query: 'Sources',
      limit: 6,
      folderId: folder,
    })
    for (const libraryFolder of [null, LibraryFolderId.make('malformed')]) {
      expect(
        recordScope(
          threadId,
          2,
          DeliveryScope.make({ acting: PersonId.make('MARK-person'), libraryFolder }),
        ).folder,
      ).toEqual(Option.none())
    }
    expect(searchRequest({ query: 'Sources', limit: 6 }, Option.none())).toEqual({
      query: 'Sources',
      limit: 6,
    })
  })
  it.effect('settles missing attribution before tools can access the RPC client', () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        yield* Scope
        return { output: { ok: true } }
      }).pipe(Effect.provide(scopeLayer('thread', { kind: 'user', body: 'Do it.' }, Option.none())))
      expect((yield* settle(program)).output).toEqual({
        ok: false,
        message: 'There is no person behind this message to act for.',
      })
    }),
  )
})
