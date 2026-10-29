import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { FeedItem, ServiceId, WatchState } from '@vivid/contracts'
import { and, eq, sql } from 'drizzle-orm'
import { Config, Duration, Effect, Option, Redacted, Schema, Stream } from 'effect'
import {
  ExecutorAppId,
  ExecutorAppOwnership,
  ExecutorBinding,
  ExecutorOwnerId,
  ExecutorReferences,
} from '../connections/executor.ts'
import { encodeReferences } from '../connections/records.ts'
import { connections } from '../connections/tables.ts'
import { Database } from '../database/client.ts'
import { chainFixture, chainLayer, completeRun, toolParts } from '../runtime/chains.ts'
import { runs, threads } from '../threads/tables.ts'

/**
 * The whole proactive path on the real stack: a Person asks Vivid in a Thread to watch an
 * Integration, Vivid subscribes through Executor's MCP `events/subscribe` (Executor verifies the
 * public callback first), the Integration's app emits an event, Executor delivers it signed, and
 * Vivid wakes in a Background Thread whose work reaches the Person only through their Feed.
 *
 * Needs the running stack (`runtime/chains.ts`) on a public HTTPS `PUBLIC_URL`, an Executor at
 * 2.0.0-beta.23 named by the `VIVID_EXECUTOR_*` settings, and the proof app
 * (`ping.sent`, filter `channel`, emitted by its `ping` mutation) deployed there as
 * `VIVID_TEST_WATCH_APP`. The Integration row is written directly: adding an arbitrary app
 * through `AddIntegration` is not what this proves.
 */

const Tools = Schema.Struct({ version: Schema.String })
const decodeTools = Schema.decodeUnknownEffect(Schema.fromJsonString(Tools))

/** One call of the proof app's `ping` mutation, in Executor's `tools/call` shape. */
interface PingCall {
  readonly version: string
  readonly kind: 'mutation'
  readonly tool: 'ping'
  readonly input: { readonly channel: string; readonly text: string }
}

/** Executor's own management API, as the proof app's owner calls it; never the Person's path. */
const executorRequest = Effect.fn('WatchProof.executor')(function* (
  path: string,
  call: Option.Option<PingCall>,
) {
  const url = yield* Config.String('VIVID_EXECUTOR_URL')
  const organization = yield* Config.String('VIVID_EXECUTOR_ORGANIZATION')
  const key = yield* Config.Redacted('VIVID_EXECUTOR_KEY')
  const response = yield* Effect.promise(() =>
    fetch(`${url}/api/organizations/${organization}${path}`, {
      method: Option.isSome(call) ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${Redacted.value(key)}`,
        'content-type': 'application/json',
      },
      body: Option.isSome(call) ? JSON.stringify(call.value) : null,
    }),
  )
  const text = yield* Effect.promise(() => response.text())
  expect(response.status, `Executor ${path}`).toBe(200)
  return text
})

/** The proof app's `ping` mutation: it emits `ping.sent` on the given channel. */
const ping = Effect.fn('WatchProof.ping')(function* (app: string, channel: string, text: string) {
  const tools = yield* executorRequest(`/apps/${app}/tools`, Option.none())
  const { version } = yield* decodeTools(tools)
  yield* executorRequest(
    `/apps/${app}/tools/call`,
    Option.some({ version, kind: 'mutation', tool: 'ping', input: { channel, text } }),
  )
})

const fromWatch = (item: FeedItem) => item.thread.startsWith('watch-')

describe.skipIf(process.env['VIVID_LIVE_WATCH_FEED'] !== '1')('Watch to Feed live chain', () => {
  layer(chainLayer, { excludeTestServices: true, timeout: 420_000 })((test) => {
    test.effect(
      'an event Vivid was asked to watch wakes it in the background and reaches the Feed',
      () =>
        Effect.gen(function* () {
          const app = yield* Config.String('VIVID_TEST_WATCH_APP')
          const fixture = yield* chainFixture('Watch proof')
          const database = yield* Database
          const now = Date.now()
          // Deleted with the Person by the fixture's cleanup.
          yield* database.run(
            database.insert(connections).values({
              id: NodeCrypto.randomUUID(),
              service: 'watch-proof',
              serviceName: 'Watch Proof',
              name: null,
              identity: null,
              label: 'Watch Proof',
              personId: fixture.personId,
              companyId: null,
              references: yield* encodeReferences(
                ExecutorReferences.cases.Public.make({
                  service: ServiceId.make('watch-proof'),
                  app: ExecutorAppId.make(app),
                  owner: ExecutorOwnerId.make('owner_watch_proof'),
                  binding: ExecutorBinding.cases.Public.make({}),
                  appOwnership: ExecutorAppOwnership.cases.Dedicated.make({}),
                }),
              ),
              executorApp: app,
              status: 'ready',
              returnsTo: 'Web',
              reason: null,
              createdAt: now,
              updatedAt: now,
            }),
          )

          const asked = yield* fixture.send(
            'Watch my Watch Proof account for pings on the general channel. Each time one comes, put what it says on my Feed.',
          )
          const state = yield* completeRun(fixture, asked)
          const watched = toolParts(state).find(
            (part) => part.toolName === 'watch' && part.state === 'output-available',
          )
          expect(watched, 'Vivid must create the Watch with its watch tool').toBeDefined()
          const live = (yield* fixture.rpc.ListWatches()).watches
          expect(live.map((watch) => [watch.account, watch.event])).toEqual([
            ['Watch Proof', 'ping.sent'],
          ])
          const [watch] = live
          if (watch === undefined)
            return yield* Effect.sync(() => expect.fail('Vivid must have one live Watch'))
          expect(WatchState.guards.Active(watch.state)).toBe(true)
          yield* Effect.addFinalizer(() =>
            fixture.rpc
              .StopWatch({ name: watch.name })
              .pipe(Effect.catch(() => Effect.sync(() => expect.fail('Watch proof stop failed')))),
          )

          // A ping on another channel does not match the Watch's filter; the general one does.
          yield* ping(app, 'random', 'not for the Feed')
          yield* ping(app, 'general', 'The 4pm call moved to 5pm.')

          // The Feed changes live as the background work starts and ends; take it once settled
          // or waiting on the Person, never by polling.
          const settled = yield* fixture.rpc.WatchFeed().pipe(
            Stream.filter((current) =>
              current.items.some(
                (item) =>
                  fromWatch(item) &&
                  (FeedItem.guards.Settled(item) || FeedItem.guards.Waiting(item)),
              ),
            ),
            Stream.runHead,
            Effect.timeout(Duration.minutes(4)),
          )
          if (Option.isNone(settled))
            return yield* Effect.sync(() => expect.fail('The Feed stream ended'))
          const items = settled.value.items.filter(fromWatch)
          expect(items).toHaveLength(1)
          const [item] = items
          if (item === undefined || item.post === null)
            return yield* Effect.sync(() => expect.fail('Vivid must post the ping to the Feed'))
          // The card may say it in words or draw it; either way the Person reads the time.
          expect(JSON.stringify(item.post)).toMatch(/5\s?pm/i)

          // Background work never enters the Person's Thread list.
          const listed = (yield* fixture.rpc.ListThreads()).threads.map((thread) => thread.id)
          expect(listed).not.toContain(item.thread)
          const [background] = yield* database.run(
            database
              .select({ place: threads.place, person: threads.personId })
              .from(threads)
              .where(eq(threads.id, item.thread)),
          )
          expect(background).toEqual({ place: 'Background', person: fixture.personId })
          const woke = yield* database.run(
            database
              .select({ origin: sql<string>`${runs.origin}->>'_tag'` })
              .from(runs)
              .where(eq(runs.threadId, item.thread)),
          )
          expect(woke).toEqual([{ origin: 'Watch' }])
          // The Person owns only this Watch. A filtered-out event must start no background Run.
          const deliveries = yield* database.run(
            database
              .select({ thread: runs.threadId })
              .from(runs)
              .where(
                and(
                  eq(runs.personId, fixture.personId),
                  sql`${runs.origin}->>'_tag' = 'Watch'`,
                  sql`${runs.origin}->>'watchName' = ${watch.name}`,
                ),
              ),
          )
          expect(deliveries).toEqual([{ thread: item.thread }])
        }).pipe(Effect.scoped),
      { timeout: 420_000 },
    )
  })
})
