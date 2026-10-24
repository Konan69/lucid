import * as NodeCrypto from 'node:crypto'
import { NodeHttpClient } from '@effect/platform-node'
import { layer } from '@effect/vitest'
import { PersonId, ThreadId } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { Effect, Layer, Option } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { describe, expect } from 'vitest'
import { personTable } from '../auth/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Runtime } from '../runtime/client.ts'
import { findThread } from '../threads/access.ts'
import { ThreadTitles, threadTitlesLayer } from '../threads/generation.ts'
import { threadStoreLayer } from '../threads/store.ts'
import { threads } from '../threads/tables.ts'
import { memoryModelLayer } from './model.ts'

const enabled = process.env['VIVID_LIVE_SERVER_MODEL'] === '1' && testDatabaseConfigured

/** Record only status and endpoint; provider payloads can contain credentials or private input. */
const observedClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return HttpClient.transform(client, (effect) =>
      effect.pipe(
        Effect.tap((response) =>
          Effect.logInfo('Title provider receipt', { status: response.status }),
        ),
      ),
    )
  }),
).pipe(Layer.provide(NodeHttpClient.layerUndici))

/** Recorded Flue history isolates this live claim to title generation and its real guarded SQL write. */
const history = Layer.mock(Runtime, {
  read: () =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        HttpClientRequest.get('http://runtime.test'),
        new Response(
          JSON.stringify({
            v: 1,
            messages: [
              {
                role: 'user',
                purpose: 'user',
                parts: [
                  { type: 'text', state: 'done', text: 'Plan a holiday in Florence, Italy.' },
                ],
              },
            ],
            settlements: [],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    ),
})
const dependencies = Layer.mergeAll(
  testDatabaseLayer,
  threadStoreLayer.pipe(Layer.provide(testDatabaseLayer)),
  memoryModelLayer.pipe(Layer.provide(observedClient)),
  history,
)

/** The real provider must generate and persist a title through the production ThreadTitles service. */
describe.skipIf(!enabled)('Configured server title provider', () => {
  layer(threadTitlesLayer.pipe(Layer.provideMerge(dependencies)), { excludeTestServices: true })(
    (it) => {
      it.effect('generates and persists a Thread title', () =>
        Effect.gen(function* () {
          const database = yield* Database
          const titles = yield* ThreadTitles
          const person = PersonId.make(NodeCrypto.randomUUID())
          const thread = ThreadId.make(NodeCrypto.randomUUID())
          yield* Effect.addFinalizer(() =>
            database
              .run(database.delete(threads).where(eq(threads.id, thread)))
              .pipe(
                Effect.andThen(
                  database.run(database.delete(personTable).where(eq(personTable.id, person))),
                ),
                Effect.asVoid,
              ),
          )
          yield* database.run(
            database
              .insert(personTable)
              .values({ id: person, name: 'Ada', email: `${person}@example.test` }),
          )
          yield* database.run(
            database
              .insert(threads)
              .values({
                id: thread,
                personId: person,
                title: 'New thread',
                titleSource: 'Seed',
                updatedAt: 0,
              }),
          )
          const before = yield* findThread(thread)
          if (Option.isNone(before))
            return yield* Effect.sync(() => expect.fail('Missing fixture Thread'))
          const title = yield* titles.regenerate(before.value, person)
          expect(title).not.toBe('New thread')
          expect(title).toMatch(/Florence|Italy|holiday|trip/i)
          const after = yield* findThread(thread)
          if (Option.isNone(after))
            return yield* Effect.sync(() => expect.fail('Missing generated Thread'))
          expect(after.value.title).toBe(title)
          expect(after.value.titleSource).toBe('Generated')
        }).pipe(Effect.scoped),
      )
    },
  )
})
