import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Effect, Schema } from 'effect'
import {
  MemoryLayer,
  Note,
  NoteFile,
  RuntimePersonId,
  type PersonId,
  type RuntimeHistoryBody,
} from '../../packages/contracts/src/index.ts'

/** Bad note files fail the import rather than become an empty memory. No file contents are logged. */
class NotesUnreadable extends Schema.TaggedError<NotesUnreadable>()(
  'NotesUnreadable',
  {},
  { title: 'Source notes cannot be read' },
) {}
const attempt = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: () => new NotesUnreadable() })
const decodePerson = Schema.decodeUnknownEffect(RuntimePersonId)
const decodeNote = Schema.decodeUnknownEffect(Note)
const layerOf = Schema.decodeUnknownOption(MemoryLayer)

/** Match main's stored header and trimEnd rule, preserving the kind, description and Markdown body. */
const parsed = (file: string, layer: MemoryLayer, text: string, updatedAt: number) => {
  const match = /^---\nkind: (.*)\ndescription: (.*)\n---\n\n([\s\S]*)$/u.exec(text)
  if (match === null || match[3] === undefined) return Effect.fail(new NotesUnreadable())
  return decodeNote({
    file,
    layer,
    kind: match[1],
    description: match[2],
    body: match[3].trimEnd(),
    basis: 'said',
  }).pipe(
    Effect.map((note) => ({ ...note, updatedAt })),
    Effect.mapError(() => new NotesUnreadable()),
  )
}

const decodeEntries = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ino: Schema.Int,
      name: Schema.String,
      mode: Schema.Int,
      mtime: Schema.Int,
      mtime_nsec: Schema.Int,
    }),
  ),
)
const decodeChunks = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ data: Schema.Uint8Array })),
)

/** Read the AgentFS 0.4 inode/data schema using Node's SQLite so the bundle needs no native addon.
 * Open a scratch copy read-only, retaining the stopped source's WAL and nanosecond mtime. */
const read = Effect.fn('HistoryReader.notes')(function* (directory: string, person: PersonId) {
  const scratch = yield* Effect.acquireRelease(
    attempt(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-history-notes-'))),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  )
  const name = `${person}.db`
  const siblings = yield* attempt(() => NodeFSP.readdir(directory))
  for (const file of siblings.filter((file) => file === name || file === `${name}-wal`))
    yield* attempt(() =>
      NodeFSP.copyFile(NodePath.join(directory, file), NodePath.join(scratch, file)),
    )
  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new DatabaseSync(NodePath.join(scratch, name), { readOnly: true }),
      catch: () => new NotesUnreadable(),
    }),
    (opened) => Effect.sync(() => opened.close()),
  )
  const entries = (parent: number) =>
    Effect.try({
      try: () =>
        database
          .prepare(
            'SELECT d.name, i.ino, i.mode, i.mtime, i.mtime_nsec FROM fs_dentry d JOIN fs_inode i ON i.ino = d.ino WHERE d.parent_ino = ? ORDER BY d.name',
          )
          .all(parent),
      catch: () => new NotesUnreadable(),
    }).pipe(
      Effect.flatMap(decodeEntries),
      Effect.mapError(() => new NotesUnreadable()),
    )
  const content = (ino: number) =>
    Effect.try({
      try: () =>
        database.prepare('SELECT data FROM fs_data WHERE ino = ? ORDER BY chunk_index').all(ino),
      catch: () => new NotesUnreadable(),
    }).pipe(
      Effect.flatMap(decodeChunks),
      Effect.map((chunks) => Buffer.concat(chunks.map((chunk) => chunk.data)).toString('utf8')),
      Effect.mapError(() => new NotesUnreadable()),
    )
  const notes: Array<RuntimeHistoryBody['notes'][number]> = []
  for (const entry of yield* entries(1)) {
    if ((entry.mode & 0o170000) === 0o100000) {
      notes.push(
        yield* parsed(
          entry.name,
          'memory',
          yield* content(entry.ino),
          entry.mtime * 1000 + entry.mtime_nsec / 1000000,
        ),
      )
      continue
    }
    const layer = layerOf(entry.name)
    if ((entry.mode & 0o170000) !== 0o040000 || layer._tag === 'None')
      return yield* new NotesUnreadable()
    for (const file of yield* entries(entry.ino)) {
      if ((file.mode & 0o170000) !== 0o100000 || !Schema.is(NoteFile)(file.name))
        return yield* new NotesUnreadable()
      notes.push(
        yield* parsed(
          file.name,
          layer.value,
          yield* content(file.ino),
          file.mtime * 1000 + file.mtime_nsec / 1000000,
        ),
      )
    }
  }
  return notes
})

/** Notes-only Persons are imported too; absence of a file is not an empty file opened by the SDK. */
export const readNotes = Effect.fn('HistoryReader.allNotes')(function* (directory: string) {
  const files = yield* attempt(() => NodeFSP.readdir(directory))
  const people = new Map<PersonId, Array<RuntimeHistoryBody['notes'][number]>>()
  for (const file of files.filter((file) => file.endsWith('.db')).sort()) {
    const person = yield* decodePerson(file.slice(0, -3)).pipe(
      Effect.mapError(() => new NotesUnreadable()),
    )
    people.set(person, yield* read(directory, person))
  }
  return people
})
