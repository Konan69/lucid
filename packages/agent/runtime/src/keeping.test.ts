import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import {
  PersonId,
  RuntimeAdmissionBody,
  RuntimeRunRequest,
  RuntimeRunResponse,
  ThreadId,
  ThreadOrigin,
} from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import { testDatabaseConfigured } from '../tests/schema.ts'
import { routes, Settled, type Routes } from '../tests/routes.ts'
import { Note, NoteFile, Notes, NotesUnavailable } from './notes.ts'
import { notesLayer } from './keeping.ts'

/** Response-body rejection is separate from a rejected admission or malformed receipt. */
class ResponseReadFailed extends Schema.TaggedError<ResponseReadFailed>()(
  'ResponseReadFailed',
  {},
  { title: 'Runtime response read failed' },
) {}

const encodeAdmission = Schema.encodeEffect(Schema.fromJsonString(RuntimeAdmissionBody))
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(RuntimeRunResponse))

/** Separate Threads share only the Person's SQLite file; each runtime owns its disposable Flue schema. */
const admission = (person: PersonId) => {
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  const request = RuntimeRunRequest.make({
    threadId,
    idempotencyKey: NodeCrypto.randomUUID(),
    type: 'message',
    body: 'Exercise the fixture note.',
    // Production signals carry their turn so Flue can resolve the server-prepared authority.
    attributes: { from: 'Fixture Person', turn: '1' },
    turn: 1,
    scope: { acting: person },
  })
  return RuntimeAdmissionBody.make({
    ...request,
    initialData: ThreadOrigin.make({ creator: person, creatorName: 'Fixture Person' }),
  })
}

/** The real Hono boundary prepares context and Person authority before the real Vivid tool turn. */
const submit = Effect.fn('NotesRuntimeTest.submit')(function* (runtime: Routes, person: PersonId) {
  const request = admission(person)
  const response = yield* runtime.send(`/agents/vivid/${request.threadId}`, {
    method: 'POST',
    body: yield* encodeAdmission(request),
  })
  expect(response.status).toBe(202)
  const receipt = yield* decodeReceipt(
    yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => ResponseReadFailed.make({}),
    }),
  )
  return yield* runtime.settled(request.threadId, receipt.submissionId)
})

describe.skipIf(!testDatabaseConfigured)('Notes ownership through public Flue lifecycle', () => {
  it.live('writes with the real tool, stops, then reads the SQLite note in a new runtime', () =>
    Effect.gen(function* () {
      const person = PersonId.make(NodeCrypto.randomUUID())
      const note = Note.make({
        file: NoteFile.make('mornings.md'),
        kind: 'preference',
        description: 'Meetings before noon',
        body: 'Meetings before noon. Why: afternoons are for writing.',
      })
      // Scope closure awaits public flue.stop, which settles submissions and invokes storage.close.
      const previous = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* routes
          yield* runtime.writeNote(note)
          expect(yield* submit(runtime, person)).toEqual(Settled.Completed({ text: 'written' }))
          return yield* Notes.pipe(Effect.provide(notesLayer))
        }),
      )
      // A retained service must be closed by the public Flue stop, not merely replaced by a new cell.
      expect(yield* Effect.flip(previous.index(person))).toBeInstanceOf(NotesUnavailable)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* routes
          const reopened = yield* Notes.pipe(Effect.provide(notesLayer))
          expect(reopened).not.toBe(previous)
          yield* runtime.readNote(note)
          expect(yield* submit(runtime, person)).toEqual(Settled.Completed({ text: note.body }))
        }),
      )
    }).pipe(Effect.scoped),
  )
})
