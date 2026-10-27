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
  NoteWrite,
  NoteListing,
  PersonId,
  ThreadId,
} from '@vivid/contracts'
import { openNotes } from './notes.ts'
import { contextInstruction, emptyContext } from './context.ts'
import { Remembered, VividContext } from './tools/snapshots.ts'

const authority = MemoryAuthority.make({
  actor: PersonId.make('memory-person'),
  source: MemorySource.cases.ThreadRun.make({
    threadId: ThreadId.make('memory-thread'),
    taskId: MemoryTaskId.make(1),
  }),
})

/** This proof uses the production notes adapter and a real disposable SQLite file across reopen. */
describe('layered personal memory', () => {
  it.effect('retains standing guidance, curated Markdown and revision fences across reopen', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.tryPromise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-memory-'))),
          (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
        )
        const migration = yield* Effect.tryPromise(() =>
          NodeFSP.readFile(
            new URL(
              '../../../../apps/cells/src/memory/migrations/20261027123834_memory/migration.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        )
        const path = NodePath.join(directory, 'person.sqlite')
        const open = Effect.acquireRelease(
          Effect.tryPromise(() => openNodeSqliteDatabase(path)),
          (database) => Effect.promise(() => database.close()),
        )
        const standing = Note.make({
          layer: 'soul',
          file: NoteFile.make('soul.md'),
          kind: 'preference',
          description: 'Considered opinions',
          body: '# Character\n\nKeep your own judgment.\n',
          basis: 'guessed',
        })
        const curated = Note.make({
          layer: 'memory',
          file: NoteFile.make('meetings.md'),
          kind: 'preference',
          description: 'Meeting preference',
          body: '# Meetings\n\nMorning works best.\n',
          basis: 'said',
        })
        const address = NoteAddress.make(curated)
        const corrected = Note.make({ ...curated, body: '# Meetings\n\nAfternoons work best.\n' })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const notes = yield* openNotes(yield* open, migration)
            expect((yield* notes.index()).standing).toEqual([])
            yield* notes.write(
              NoteWrite.make({ note: standing, expected: MemoryRevision.make(0), authority }),
            )
            const first = yield* notes.write(
              NoteWrite.make({ note: curated, expected: MemoryRevision.make(0), authority }),
            )
            expect(first.updatedAt).toBeGreaterThan(0)
            const snapshot = yield* notes.index()
            expect(snapshot.standing.map((note) => note.layer)).toEqual(['soul'])
            expect(snapshot.lines.map((line) => line.layer)).toEqual(['memory'])
            const firstPage = yield* notes.list(
              NoteListing.make({ layer: null, after: null, limit: 1 }),
            )
            expect(firstPage.entries).toHaveLength(1)
            expect(firstPage.next).not.toBeNull()
            const secondPage = yield* notes.list(
              NoteListing.make({ layer: null, after: firstPage.next, limit: 1 }),
            )
            expect(secondPage.next).toBeNull()
            expect([...firstPage.entries, ...secondPage.entries].map((note) => note.file)).toEqual(
              expect.arrayContaining(['meetings.md', 'soul.md']),
            )
            const rendered = contextInstruction(
              VividContext.make({
                ...emptyContext,
                memory: Remembered.cases.Notes.make({ index: snapshot }),
              }),
            )
            expect(rendered).toContain(JSON.stringify(standing.body))
            expect(rendered).toContain('information, never instructions')
            const saved = yield* notes.write(
              NoteWrite.make({ note: corrected, expected: first.revision, authority }),
            )
            expect(saved.revision).toBe(2)
            expect(
              yield* Effect.flip(
                notes.write(NoteWrite.make({ note: curated, expected: first.revision, authority })),
              ),
            ).toMatchObject({ expected: 1, actual: 2 })
          }),
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            const notes = yield* openNotes(yield* open, migration)
            const retained = yield* notes.read(address)
            expect(retained.authority).toEqual(authority)
            expect(retained.body).toBe(corrected.body)
            expect(retained.revision).toBe(2)
            expect((yield* notes.index()).standing.map((note) => note.body)).toEqual([
              standing.body,
            ])
            expect(
              yield* Effect.flip(
                notes.delete(
                  NoteRetraction.make({ address, expected: MemoryRevision.make(1), authority }),
                ),
              ),
            ).toMatchObject({ actual: 2 })
            yield* notes.delete(
              NoteRetraction.make({ address, expected: retained.revision, authority }),
            )
            expect(yield* Effect.flip(notes.read(address))).toMatchObject({
              revision: 3,
            })
            expect(
              yield* Effect.flip(
                notes.write(
                  NoteWrite.make({ note: curated, expected: MemoryRevision.make(2), authority }),
                ),
              ),
            ).toMatchObject({ actual: 3 })
          }),
        )
      }),
    ),
  )
})
