import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { AgentFS } from 'agentfs-sdk'
import { Effect, Schema } from 'effect'
import {
  MemoryLayer,
  Note,
  NoteFile,
  RuntimePersonId,
  type PersonId,
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
const parsed = (file: string, layer: MemoryLayer, text: string) => {
  const match = /^---\nkind: (.*)\ndescription: (.*)\n---\n\n([\s\S]*)$/u.exec(text)
  if (match === null || match[3] === undefined) return Effect.fail(new NotesUnreadable())
  return decodeNote({
    file,
    layer,
    kind: match[1],
    description: match[2],
    body: match[3].trimEnd(),
    basis: 'guessed',
  }).pipe(Effect.mapError(() => new NotesUnreadable()))
}

/** AgentFS 0.6.4 initializes tables on open. Open only a scratch copy, retaining a stopped source's WAL. */
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
  const store = yield* Effect.acquireRelease(
    attempt(() => AgentFS.open({ path: NodePath.join(scratch, name) })),
    (opened) => Effect.promise(() => opened.close()),
  )
  const notes: Note[] = []
  for (const entry of yield* attempt(() => store.fs.readdirPlus('/'))) {
    if (entry.stats.isFile()) {
      notes.push(
        yield* parsed(
          entry.name,
          'memory',
          yield* attempt(() => store.fs.readFile(`/${entry.name}`, 'utf8')),
        ),
      )
      continue
    }
    const layer = layerOf(entry.name)
    if (layer._tag === 'None') return yield* new NotesUnreadable()
    for (const file of yield* attempt(() => store.fs.readdirPlus(`/${entry.name}`))) {
      if (!file.stats.isFile() || !Schema.is(NoteFile)(file.name))
        return yield* new NotesUnreadable()
      notes.push(
        yield* parsed(
          file.name,
          layer.value,
          yield* attempt(() => store.fs.readFile(`/${entry.name}/${file.name}`, 'utf8')),
        ),
      )
    }
  }
  return notes
})

/** Notes-only Persons are imported too; absence of a file is not an empty file opened by the SDK. */
export const readNotes = Effect.fn('HistoryReader.allNotes')(function* (directory: string) {
  const files = yield* attempt(() => NodeFSP.readdir(directory))
  const people = new Map<PersonId, Note[]>()
  for (const file of files.filter((file) => file.endsWith('.db')).sort()) {
    const person = yield* decodePerson(file.slice(0, -3)).pipe(
      Effect.mapError(() => new NotesUnreadable()),
    )
    people.set(person, yield* read(directory, person))
  }
  return people
})
