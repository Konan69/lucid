import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  MemoryAuthority,
  MemorySource,
  MemoryTaskId,
  MemoryRevision,
  MemoryEntry,
  MemoryAddress,
  MemoryFile,
  MemoryRetraction,
  MemorySearch,
  MemorySearchInvalid,
  MemoryWrite,
  PersonId,
  ThreadId,
  MemoryCitation,
  MemoryScope,
  type MemoryCitations,
} from '@vivid/contracts'
import { openMemory } from './memory.ts'

const authority = MemoryAuthority.make({
  actor: PersonId.make('search-person'),
  source: MemorySource.cases.ThreadRun.make({
    threadId: ThreadId.make('search-thread'),
    taskId: MemoryTaskId.make(1),
  }),
})
const citations: MemoryCitations = [MemoryCitation.cases.Run.make({ source: authority.source })]
const legacy = MemoryEntry.make({
  layer: 'memory',
  file: MemoryFile.make('zz-legacy.md'),
  kind: 'preference',
  description: 'Meeting preference',
  body: 'Quasarneedle: morning meetings work best. Send a follow-up email: x.',
  basis: 'said',
  scope: MemoryScope.cases.Personal.make({}),
})
const query = MemorySearch.make({ query: 'quasarneedle', layer: null, offset: 0, limit: 1 })

/** Native persistent SQLite proves migration backfill and index maintenance without mocking search. */
describe('personal memory FTS5', () => {
  it.effect(
    'finds older Markdown and updates search across corrections, retraction and reopen',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.tryPromise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-search-')),
            ),
            (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
          )
          const migrations = yield* Effect.tryPromise(() =>
            Promise.all(
              [
                '20261028123228_memory',
                '20261028123228_memory-search',
                '20261029131056_memory-provenance',
              ].map((name) =>
                NodeFSP.readFile(
                  new URL(
                    `../../../../apps/cells/src/memory/migrations/${name}/migration.sql`,
                    import.meta.url,
                  ),
                  'utf8',
                ),
              ),
            ),
          )
          const open = Effect.acquireRelease(
            Effect.tryPromise(() =>
              openNodeSqliteDatabase(NodePath.join(directory, 'person.sqlite')),
            ),
            (database) => Effect.promise(() => database.close()),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const database = yield* open
              // Rows written before search and provenance existed, in the first schema's columns.
              yield* openMemory(database, migrations.slice(0, 1))
              for (const { file, body } of [
                { file: 'filler-first.md', body: 'Discarded.' },
                { file: legacy.file, body: legacy.body },
              ])
                yield* Effect.tryPromise(() =>
                  database.run(
                    'INSERT INTO memory_entries (layer, file, kind, description, body, basis, revision, updated_at, authority) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
                    legacy.layer,
                    file,
                    legacy.kind,
                    legacy.description,
                    body,
                    legacy.basis,
                    Date.now(),
                    JSON.stringify(authority),
                  ),
                )
              const memory = yield* openMemory(database, migrations)
              // The provenance migration cites each older row's recorded Run and files it Personal.
              expect(yield* memory.read(MemoryAddress.make(legacy))).toMatchObject({
                scope: MemoryScope.cases.Personal.make({}),
                citations: [MemoryCitation.cases.Run.make({ source: authority.source })],
              })
              expect((yield* memory.search(query)).entries.map((entry) => entry.file)).toEqual([
                legacy.file,
              ])
              for (const text of [
                'follow-up',
                'email: x',
                '"follow-up email"',
                'follow*',
                'quasarneedle OR absent',
              ]) {
                expect(
                  (yield* memory.search(MemorySearch.make({ ...query, query: text }))).entries,
                ).toMatchObject([{ file: legacy.file }])
              }
              for (let number = 0; number < 40; number++) {
                yield* memory.write(
                  MemoryWrite.make({
                    entry: MemoryEntry.make({
                      ...legacy,
                      file: MemoryFile.make(`filler-${number}.md`),
                      description: 'x'.repeat(200),
                      body: 'Unrelated durable context.',
                    }),
                    expected: MemoryRevision.make(0),
                    authority,
                    citations,
                  }),
                )
              }
              expect(
                (yield* memory.index()).lines.some((entry) => entry.file === legacy.file),
              ).toBe(false)
              expect((yield* memory.search(query)).entries[0]).toMatchObject({
                file: legacy.file,
                excerpt: expect.stringContaining('Quasarneedle'),
              })
              expect(
                (yield* memory.search(MemorySearch.make({ ...query, query: '"morning meetings"' })))
                  .entries,
              ).toHaveLength(1)
              const second = MemoryEntry.make({
                ...legacy,
                file: MemoryFile.make('zzzz-second.md'),
                body: 'Quasarneedle',
              })
              yield* memory.write(
                MemoryWrite.make({
                  entry: second,
                  expected: MemoryRevision.make(0),
                  authority,
                  citations,
                }),
              )
              const firstPage = yield* memory.search(query)
              expect(firstPage.entries[0]).toMatchObject({ file: second.file })
              expect(firstPage.nextOffset).toBe(1)
              const nextPage = yield* memory.search(MemorySearch.make({ ...query, offset: 1 }))
              expect(nextPage.nextOffset).toBeNull()
              expect(
                new Set([...firstPage.entries, ...nextPage.entries].map((entry) => entry.file)),
              ).toEqual(new Set([legacy.file, second.file]))
              expect(
                (yield* memory.search(MemorySearch.make({ ...query, query: 'quasar*', limit: 25 })))
                  .entries,
              ).toHaveLength(2)
              expect(
                (yield* memory.search(MemorySearch.make({ ...query, layer: 'research' }))).entries,
              ).toEqual([])
              yield* memory.write(
                MemoryWrite.make({
                  entry: MemoryEntry.make({
                    ...legacy,
                    body: 'Nebula: evening meetings work best.',
                  }),
                  expected: MemoryRevision.make(1),
                  authority,
                  citations,
                }),
              )
              expect((yield* memory.search(query)).entries.map((entry) => entry.file)).toEqual([
                second.file,
              ])
              yield* memory.delete(
                MemoryRetraction.make({
                  address: MemoryAddress.make(second),
                  expected: MemoryRevision.make(1),
                  authority,
                }),
              )
              expect((yield* memory.search(query)).entries).toEqual([])
              for (const text of ['"', 'AND']) {
                expect(
                  yield* Effect.flip(memory.search(MemorySearch.make({ ...query, query: text }))),
                ).toBeInstanceOf(MemorySearchInvalid)
              }
              yield* Effect.promise(() =>
                database.run("DELETE FROM memory_entries WHERE file LIKE 'filler-%'"),
              )
              yield* Effect.promise(() => database.run('VACUUM'))
            }),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const memory = yield* openMemory(yield* open, migrations)
              expect((yield* memory.search(query)).entries).toEqual([])
              const retained = yield* memory.search(
                MemorySearch.make({ ...query, query: 'nebula' }),
              )
              expect(retained.entries).toMatchObject([{ file: legacy.file, revision: 2 }])
            }),
          )
        }),
      ),
  )
})
