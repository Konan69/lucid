import { describe, expect, layer } from '@effect/vitest'
import { InputRequestId, Person, PersonId, RunId, ThreadId, Workspace } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Effect, Layer, Option, Schema } from 'effect'
import type { Actor } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { inputRequests } from '../inputs/tables.ts'
import { changesLayer } from '../live/changes.ts'
import { projectStoreLayer } from '../projects/store.ts'
import { StoredRunOrigin } from './conversation.ts'
import { ThreadStore, threadStoreLayer } from './store.ts'
import { runs } from './tables.ts'

const testLayer = Layer.mergeAll(threadStoreLayer, projectStoreLayer, changesLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)
const encodeOrigin = Schema.encodeSync(StoredRunOrigin)

/** One Person and their private Thread, removed with the Person when the test ends. */
const fixture = Effect.fn('Attention.fixture')(function* () {
  const database = yield* Database
  const person = Person.make({
    id: PersonId.make(crypto.randomUUID()),
    name: 'Ada',
    email: `${crypto.randomUUID()}@example.test`,
    image: null,
  })
  yield* Effect.addFinalizer(() =>
    database.run(database.delete(personTable).where(eq(personTable.id, person.id))).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.sync(() => expect.fail('Attention cleanup failed'))),
    ),
  )
  yield* database.run(database.insert(personTable).values(person))
  const actor: Actor = {
    person,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
    helper: Option.none(),
  }
  const id = ThreadId.make(crypto.randomUUID())
  yield* (yield* ThreadStore).create(actor, { id, title: 'Plan the trip', projectId: null })
  return { database, person, actor, id }
})

describe.skipIf(!testDatabaseConfigured)('Thread attention', () => {
  layer(testLayer)((it) => {
    it.effect('a Thread with a question open reads Working while a Run works, then NeedsYou', () =>
      Effect.gen(function* () {
        const { database, person, actor, id } = yield* fixture()
        const attention = Effect.map((yield* ThreadStore).list(actor), (listed) => {
          const thread = listed.find((candidate) => candidate.id === id)
          if (thread === undefined) return expect.fail('Thread missing from list')
          return thread.attention
        })
        const runId = RunId.make(crypto.randomUUID())
        yield* database.run(
          database.insert(runs).values({
            id: runId,
            threadId: id,
            personId: person.id,
            turn: 1,
            state: 'working',
            origin: encodeOrigin(StoredRunOrigin.cases.Message.make({})),
            startedAt: 1,
            admittedAt: 1,
          }),
        )
        yield* database.run(
          database.insert(inputRequests).values({
            id: InputRequestId.make(crypto.randomUUID()),
            threadId: id,
            personId: person.id,
            runId: null,
            questions: [
              { question: 'Which city?', options: [], selection: 'One', allowsOwnAnswer: true },
            ],
            status: 'waiting',
            createdAt: 2,
          }),
        )
        expect(yield* attention).toBe('Working')
        yield* database.run(
          database
            .update(runs)
            .set({ state: 'completed', finishedAt: 3 })
            .where(eq(runs.id, runId)),
        )
        expect(yield* attention).toBe('NeedsYou')
      }).pipe(Effect.scoped),
    )
  })
})
