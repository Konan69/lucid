import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { start, type Flue } from '@flue/runtime/node'
import { PersonId } from '@vivid/contracts'
import { Context, Effect, Layer, Schema } from 'effect'
import { disposableStorage, testDatabaseConfigured } from '../tests/schema.ts'
import { Vivid } from './agents/vivid.ts'
import { Note, NoteFile, Notes, NotesUnavailable } from './notes.ts'
import { notesLayer } from './keeping.ts'

/** Startup can fail before a public stop handle owns the disposable storage. */
class NotesRuntimeStartFailed extends Schema.TaggedError<NotesRuntimeStartFailed>()(
  'NotesRuntimeStartFailed',
  {},
  { title: 'Notes runtime start failed' },
) {}

/** Shutdown failure must fail the assertion and the fixture's scoped cleanup. */
class NotesRuntimeStopFailed extends Schema.TaggedError<NotesRuntimeStopFailed>()(
  'NotesRuntimeStopFailed',
  {},
  { title: 'Notes runtime stop failed' },
) {}

/** The SDK stop Promise is shared by the explicit assertion and failure cleanup. */
const stopRuntime = Effect.fn('NotesRuntimeTest.stop')((runtime: Flue) =>
  Effect.tryPromise({
    try: () => runtime.stop(),
    catch: () => NotesRuntimeStopFailed.make({}),
  }),
)

/**
 * Public Flue start/stop owns production storage and its closeNotes callback. Each start gets
 * an empty PostgreSQL schema, so startup reconciliation has no submissions to run. No agent
 * is dispatched and no model request is made. Production notesLayer uses the worker's Notes
 * directory from tests/setup.ts and builds the real ManagedRuntime with production settings.
 */
const openRuntime = Effect.fn('NotesRuntimeTest.open')(function* () {
  const { schema, storage } = yield* disposableStorage
  const flue = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => start({ agents: [Vivid], db: storage }),
      catch: () => NotesRuntimeStartFailed.make({}),
    }),
    (runtime) =>
      stopRuntime(runtime).pipe(
        Effect.catch(() => Effect.sync(() => expect.fail('Notes runtime stop failed'))),
      ),
  )
  const notes = Context.get(yield* Layer.build(notesLayer), Notes)
  return { schema, notes, stop: stopRuntime(flue) }
})

/** Acquire cold Flue, PostgreSQL and native SQLite dependencies before the timed assertion. */
const fixture = Effect.gen(function* () {
  const first = yield* openRuntime()
  const person = PersonId.make(NodeCrypto.randomUUID())
  yield* first.notes.index(person)
  return { first, person }
}).pipe(Effect.withSpan('NotesRuntimeTest.fixture'))

/** The test keeps the first real authority after its public Flue owner stops. */
class NotesRuntime extends Context.Service<NotesRuntime, Effect.Success<typeof fixture>>()(
  'NotesRuntimeTest',
) {}

/** The case scope owns the reopened runtime; the outer layer retains the stopped authority. */
const lifecycle = Effect.gen(function* () {
  const { first, person } = yield* NotesRuntime
  const note = Note.make({
    file: NoteFile.make('mornings.md'),
    kind: 'preference',
    description: 'Meetings before noon',
    body: 'Meetings before noon. Why: afternoons are for writing.',
  })
  yield* first.notes.write(person, note)
  yield* first.stop
  expect(yield* Effect.flip(first.notes.index(person))).toBeInstanceOf(NotesUnavailable)
  const reopened = yield* openRuntime()
  expect(reopened.schema).not.toBe(first.schema)
  expect(reopened.notes).not.toBe(first.notes)
  expect(yield* reopened.notes.read(person, note.file)).toEqual(note)
}).pipe(Effect.withSpan('NotesRuntimeTest.lifecycle'))

describe.skipIf(!testDatabaseConfigured)('Notes ownership through public Flue lifecycle', () => {
  layer(Layer.effect(NotesRuntime, fixture), { excludeTestServices: true })(
    'native storage',
    (it) => {
      it.effect(
        'closes real Notes on Flue stop and reopens the persisted SQLite note',
        () => lifecycle,
      )
    },
  )
})
