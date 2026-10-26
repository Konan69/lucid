import {
  INDEX_BUDGET,
  Note,
  NoteIndex,
  NoteLine,
  NoteMissing,
  Notes,
  NotesUnavailable,
  type NoteFile,
} from '@vivid/agent-runtime/cell'
import type { PersonId } from '@vivid/contracts'
import { Effect, Layer, Option, Schema } from 'effect'
import type { CellStorage } from './cloudflare.ts'

/**
 * The table that holds this Person's notes, in the cell's own SQLite beside Pi's tables. The
 * runtime keeps notes as AgentFS files (`notes.ts` there); a cell has no filesystem to keep them
 * in, so a row per note carries the same four fields and the time of its last change, which is
 * what the index orders by (the files' mtime in AgentFS).
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS vivid_notes (
  file TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  changed INTEGER NOT NULL
)`

const decodeRow = Schema.decodeUnknownEffect(Note)
const decodeLine = Schema.decodeUnknownEffect(NoteLine)

/**
 * The cell's `Notes`: index, read, write and delete over `vivid_notes`, with the runtime's own
 * schemas, budget and failures. The cell serves one Person, so a call for anyone else is refused
 * as unavailable rather than answered from this Person's notes.
 */
export const notesLayer = (storage: CellStorage, owner: PersonId) =>
  Layer.effect(
    Notes,
    Effect.gen(function* () {
      yield* run(() => storage.sql.exec(SCHEMA))
      const mine = (person: PersonId) =>
        person === owner ? Effect.void : Effect.fail(NotesUnavailable.make({}))
      return Notes.of({
        index: (person) => Effect.andThen(mine(person), index(storage)),
        read: (person, file) => Effect.andThen(mine(person), read(storage, file)),
        write: (person, note) => Effect.andThen(mine(person), write(storage, note)),
        delete: (person, file) => Effect.andThen(mine(person), remove(storage, file)),
      })
    }),
  )

/** One synchronous SQL call; SQLite refusing it is the store being unavailable, never "no notes". */
const run = <A>(call: () => A) => Effect.try({ try: call, catch: () => NotesUnavailable.make({}) })

/** Newest change first, cut at the runtime's budget of file name plus description characters. */
const index = (storage: CellStorage) =>
  Effect.gen(function* () {
    const rows = yield* run(() =>
      storage.sql.exec('SELECT file, kind, description FROM vivid_notes ORDER BY changed DESC').toArray(),
    )
    const lines: Array<NoteLine> = []
    let used = 0
    for (const row of rows) {
      const line = yield* decodeLine(row).pipe(Effect.mapError(() => NotesUnavailable.make({})))
      used += line.file.length + line.description.length
      if (used > INDEX_BUDGET && lines.length > 0) return NoteIndex.make({ lines, more: true })
      lines.push(line)
    }
    return NoteIndex.make({ lines, more: false })
  })

/** One note whole; a stored row that no longer decodes is missing, as a malformed file is there. */
const read = (storage: CellStorage, file: NoteFile) =>
  Effect.gen(function* () {
    const rows = yield* run(() =>
      storage.sql.exec('SELECT file, kind, description, body FROM vivid_notes WHERE file = ?', file).toArray(),
    )
    const row = Option.fromUndefinedOr(rows[0])
    if (Option.isNone(row)) return yield* NoteMissing.make({ file })
    return yield* decodeRow(row.value).pipe(Effect.mapError(() => NoteMissing.make({ file })))
  })

/** Write or replace one note in a single statement; answers whether one was replaced. */
const write = (storage: CellStorage, note: Note) =>
  run(() => {
    const before = storage.sql.exec('SELECT 1 FROM vivid_notes WHERE file = ?', note.file).toArray()
    storage.sql.exec(
      `INSERT INTO vivid_notes (file, kind, description, body, changed) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(file) DO UPDATE SET kind = excluded.kind, description = excluded.description,
       body = excluded.body, changed = excluded.changed`,
      note.file,
      note.kind,
      note.description.replace(/\s+/gu, ' ').trim(),
      note.body.trim(),
      Date.now(),
    )
    return before.length > 0
  })

/** Delete one note; a name with no note is the runtime's precise `NoteMissing`. */
const remove = (storage: CellStorage, file: NoteFile) =>
  Effect.gen(function* () {
    const gone = yield* run(
      () => storage.sql.exec('DELETE FROM vivid_notes WHERE file = ? RETURNING file', file).toArray().length,
    )
    if (gone === 0) return yield* NoteMissing.make({ file })
  })
