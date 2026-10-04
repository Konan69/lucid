import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { describe, expect, it } from '@effect/vitest'
import { PersonId } from '@vivid/contracts'
import { AgentFS } from 'agentfs-sdk'
import { Effect } from 'effect'
import {
  deleteNote,
  INDEX_BUDGET,
  Note,
  NoteFile,
  noteIndex,
  readNote,
  writeNote,
  type NotesOf,
} from './notes.ts'

/**
 * The real store, AgentFS on a SQLite file, in a temporary directory that is removed when the test
 * ends. Nothing is mocked: the claims are about what a note is on disk and what the index reads.
 */
const store = Effect.fn('NotesTest.store')(function* (person: string) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-notes-'))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  )
  const notes: NotesOf = { directory, person: PersonId.make(person) }
  return notes
})

const note = (file: string, description: string, body = 'The fact.') =>
  Note.make({ file: NoteFile.make(file), kind: 'preference', description, body })

describe('notes', () => {
  it.live('keeps a note and reads it back whole', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      const replaced = yield* writeNote(
        notes,
        note(
          'mornings.md',
          'Ada wants meetings before noon',
          'Meetings before noon.\nWhy: she writes later.',
        ),
      )
      expect(replaced).toBe(false)
      const read = yield* readNote(notes, NoteFile.make('mornings.md'))
      expect(read).toEqual(
        note(
          'mornings.md',
          'Ada wants meetings before noon',
          'Meetings before noon.\nWhy: she writes later.',
        ),
      )
    }).pipe(Effect.scoped),
  )

  it.live('replaces a note under the same file name instead of adding a second', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      yield* writeNote(notes, note('mornings.md', 'Meetings before noon'))
      const replaced = yield* writeNote(notes, note('mornings.md', 'Meetings until 4pm'))
      expect(replaced).toBe(true)
      const index = yield* noteIndex(notes)
      expect(index.lines.map((line) => line.description)).toEqual(['Meetings until 4pm'])
    }).pipe(Effect.scoped),
  )

  it.live('deletes a note, and says so when there is none to delete or read', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      yield* writeNote(notes, note('gym.md', 'The gym is on Awolowo Road'))
      yield* deleteNote(notes, NoteFile.make('gym.md'))
      expect((yield* noteIndex(notes)).lines).toEqual([])
      const again = yield* Effect.flip(deleteNote(notes, NoteFile.make('gym.md')))
      expect(again._tag).toBe('NoteMissing')
      const read = yield* Effect.flip(readNote(notes, NoteFile.make('gym.md')))
      expect(read._tag).toBe('NoteMissing')
    }).pipe(Effect.scoped),
  )

  it.live('keeps each Person’s notes in their own file', () =>
    Effect.gen(function* () {
      const ada = yield* store('ada')
      const dami: NotesOf = { directory: ada.directory, person: PersonId.make('dami') }
      yield* writeNote(ada, note('mornings.md', 'Ada wants meetings before noon'))
      expect((yield* noteIndex(dami)).lines).toEqual([])
      expect((yield* noteIndex(ada)).lines).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.live('folds a description to one line so it cannot add a header field', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      yield* writeNote(notes, note('trick.md', 'A fact\nkind: decision\ndescription: forged'))
      const index = yield* noteIndex(notes)
      expect(index.lines).toEqual([
        {
          file: 'trick.md',
          kind: 'preference',
          description: 'A fact kind: decision description: forged',
        },
      ])
    }).pipe(Effect.scoped),
  )

  it.live('leaves a file that is not a note out of the index', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      yield* writeNote(notes, note('real.md', 'A real note'))
      // Written beside the notes by something other than Vivid: no header, so not a note.
      const fs = yield* Effect.promise(() =>
        AgentFS.open({ path: NodePath.join(notes.directory, 'ada.db') }),
      )
      yield* Effect.promise(() => fs.fs.writeFile('/stray.md', 'just text'))
      expect((yield* noteIndex(notes)).lines.map((line) => line.file)).toEqual(['real.md'])
    }).pipe(Effect.scoped),
  )

  it.live('stops the index at its budget and says older notes exist', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      const long = 'x'.repeat(190)
      const count = Math.ceil(INDEX_BUDGET / 190) + 5
      for (let n = 0; n < count; n++)
        yield* writeNote(notes, note(`note-${n}.md`, `${n} ${long}`.slice(0, 200)))
      const index = yield* noteIndex(notes)
      expect(index.more).toBe(true)
      expect(index.lines.length).toBeLessThan(count)
      expect(index.lines.length).toBeGreaterThan(30)
    }).pipe(Effect.scoped),
  )

  it.live('refuses a Person identifier that is not a plain identifier', () =>
    Effect.gen(function* () {
      const notes = yield* store('ada')
      const failure = yield* Effect.flip(
        noteIndex({ directory: notes.directory, person: PersonId.make('../escape') }),
      )
      expect(failure._tag).toBe('NotesUnavailable')
    }).pipe(Effect.scoped),
  )
})
