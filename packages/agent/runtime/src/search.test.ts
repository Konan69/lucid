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
  Note,
  NoteAddress,
  NoteFile,
  NoteRetraction,
  NoteSearch,
  NoteSearchInvalid,
  NoteWrite,
  PersonId,
  ThreadId,
} from '@vivid/contracts'
import { openNotes } from './notes.ts'

const authority = MemoryAuthority.make({
  actor: PersonId.make('search-person'),
  source: MemorySource.cases.ThreadRun.make({
    threadId: ThreadId.make('search-thread'),
    taskId: MemoryTaskId.make(1),
  }),
})
const legacy = Note.make({
  layer: 'memory',
  file: NoteFile.make('zz-legacy.md'),
  kind: 'preference',
  description: 'Meeting preference',
  body: 'Quasarneedle: morning meetings work best.',
  basis: 'said',
})
const query = NoteSearch.make({ query: 'quasarneedle', layer: null, offset: 0, limit: 1 })

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
              ['20261027123834_memory', '20261027133147_memory-search'].map((name) =>
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
              const previous = yield* openNotes(database, migrations.slice(0, 1))
              yield* previous.write(
                NoteWrite.make({ note: legacy, expected: MemoryRevision.make(0), authority }),
              )
              const notes = yield* openNotes(database, migrations)
              expect((yield* notes.search(query)).entries.map((entry) => entry.file)).toEqual([
                legacy.file,
              ])
              for (let number = 0; number < 40; number++) {
                yield* notes.write(
                  NoteWrite.make({
                    note: Note.make({
                      ...legacy,
                      file: NoteFile.make(`filler-${number}.md`),
                      description: 'x'.repeat(200),
                      body: 'Unrelated durable context.',
                    }),
                    expected: MemoryRevision.make(0),
                    authority,
                  }),
                )
              }
              expect((yield* notes.index()).lines.some((entry) => entry.file === legacy.file)).toBe(
                false,
              )
              expect((yield* notes.search(query)).entries[0]).toMatchObject({
                file: legacy.file,
                excerpt: expect.stringContaining('Quasarneedle'),
              })
              expect(
                (yield* notes.search(NoteSearch.make({ ...query, query: '"morning meetings"' })))
                  .entries,
              ).toHaveLength(1)
              const second = Note.make({
                ...legacy,
                file: NoteFile.make('zzzz-second.md'),
                body: 'Quasarneedle',
              })
              yield* notes.write(
                NoteWrite.make({ note: second, expected: MemoryRevision.make(0), authority }),
              )
              const firstPage = yield* notes.search(query)
              expect(firstPage.entries[0]).toMatchObject({ file: second.file })
              expect(firstPage.nextOffset).toBe(1)
              const nextPage = yield* notes.search(NoteSearch.make({ ...query, offset: 1 }))
              expect(nextPage.nextOffset).toBeNull()
              expect(
                new Set([...firstPage.entries, ...nextPage.entries].map((entry) => entry.file)),
              ).toEqual(new Set([legacy.file, second.file]))
              expect(
                (yield* notes.search(NoteSearch.make({ ...query, query: 'quasar*', limit: 25 })))
                  .entries,
              ).toHaveLength(2)
              expect(
                (yield* notes.search(NoteSearch.make({ ...query, layer: 'research' }))).entries,
              ).toEqual([])
              yield* notes.write(
                NoteWrite.make({
                  note: Note.make({ ...legacy, body: 'Nebula: evening meetings work best.' }),
                  expected: MemoryRevision.make(1),
                  authority,
                }),
              )
              expect((yield* notes.search(query)).entries.map((entry) => entry.file)).toEqual([
                second.file,
              ])
              yield* notes.delete(
                NoteRetraction.make({
                  address: NoteAddress.make(second),
                  expected: MemoryRevision.make(1),
                  authority,
                }),
              )
              expect((yield* notes.search(query)).entries).toEqual([])
              expect(
                yield* Effect.flip(notes.search(NoteSearch.make({ ...query, query: '"' }))),
              ).toBeInstanceOf(NoteSearchInvalid)
            }),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              const notes = yield* openNotes(yield* open, migrations)
              expect((yield* notes.search(query)).entries).toEqual([])
              const retained = yield* notes.search(NoteSearch.make({ ...query, query: 'nebula' }))
              expect(retained.entries).toMatchObject([{ file: legacy.file, revision: 2 }])
            }),
          )
        }),
      ),
  )
})
