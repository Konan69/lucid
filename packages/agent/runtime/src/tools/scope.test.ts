import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { LibraryFolderId } from '@vivid/contracts'
import { folderOf, scopeLayer, Scope } from './scope.ts'
import { searchRequest } from './library.ts'
import { settle } from './result.ts'

const attributesOf = Schema.Record(Schema.String, Schema.String)
const folder = '3a1c68db-241e-4b59-a0aa-4b18867d6da1'

/** Server scope is decoded independently of model input, with absent and malformed deliveries safe. */
describe('Routine Library authority', () => {
  it('uses only a valid server signal folder and puts it in the search request', () => {
    const decoded = folderOf({
      kind: 'signal',
      type: 'schedule',
      body: 'Search the folder.',
      attributes: { libraryFolder: folder },
    })
    expect(decoded).toEqual(Option.some(LibraryFolderId.make(folder)))
    expect(searchRequest({ query: 'Sources', limit: 6 }, decoded)).toEqual({
      query: 'Sources',
      limit: 6,
      folderId: folder,
    })
    for (const attributes of [
      attributesOf.make({}),
      { libraryFolder: '' },
      { libraryFolder: 'not-a-folder' },
    ]) {
      expect(folderOf({ kind: 'signal', type: 'schedule', body: 'Search.', attributes })).toEqual(
        Option.none(),
      )
    }
    expect(folderOf({ kind: 'user', body: folder })).toEqual(Option.none())
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
      }).pipe(Effect.provide(scopeLayer(Option.none(), { kind: 'user', body: 'Do it.' })))
      expect((yield* settle(program)).output).toEqual({
        ok: false,
        message: 'There is no person behind this message to act for.',
      })
    }),
  )
})
