import * as NodeAsyncHooks from 'node:async_hooks'
import * as NodeTimersPromises from 'node:timers/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { Config, Effect, Option, Redacted, Schema } from 'effect'
import { Pool } from 'pg'
import { openPgStorage } from '../../main.ts'
const decodeSchema = Schema.decodeUnknownSync(Schema.String)
const decodeSize = Schema.decodeUnknownSync(Schema.FiniteFromString)
/** One real storage round trip in a bounded-heap child. Parent registers random
 * schema removal before spawning. Event-loop delay is measurement only, never a
 * readiness mechanism or timing assertion. No provider or shared database is used. */
function main() {
  return Effect.scoped(
    Effect.gen(function* () {
      const url = Redacted.value(yield* Config.Redacted('VIVID_TEST_DATABASE_URL'))
      if (new URL(url).port === '55433') throw new Error('Refusing developer database')
      const megabytes = decodeSize(process.argv[2])
      const schema = decodeSchema(process.argv[3])
      const pool = yield* Effect.acquireRelease(
        Effect.sync(
          () => new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 }),
        ),
        (owned) => Effect.promise(() => owned.end()),
      )
      const storage = yield* Effect.acquireRelease(
        Effect.promise(() => openPgStorage(pool, schema)),
        (owned) => Effect.promise(() => owned.close(BACKGROUND_CONTEXT)),
      )
      const conversationId = yield* Effect.promise(() => storage.mintId<ConversationId>())
      yield* Effect.promise(() =>
        storage.commit(
          [{ type: 'conversation', value: { id: conversationId } }],
          BACKGROUND_CONTEXT,
        ),
      )
      const id = yield* Effect.promise(() => storage.mintId<EntryId>())
      const payload = 'A'.repeat(megabytes * 1024 * 1024)
      // A timer histogram misses work before its first tick. Async callback spans
      // measure each synchronous turn directly, with no sampling timer or polling.
      let longestCallbackMs = 0
      const callbacks = new Map<number, number>()
      const turns = NodeAsyncHooks.createHook({
        before(asyncId) {
          callbacks.set(asyncId, performance.now())
        },
        after(asyncId) {
          const started = callbacks.get(asyncId)
          if (started !== undefined)
            longestCallbackMs = Math.max(longestCallbackMs, performance.now() - started)
          callbacks.delete(asyncId)
        },
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => turns.disable()))
      turns.enable()
      yield* Effect.promise(() => NodeTimersPromises.setImmediate())
      const started = performance.now()
      yield* Effect.promise(() =>
        storage.commit(
          [{ type: 'entry', value: { id, conversationId, kind: 'large', data: payload } }],
          BACKGROUND_CONTEXT,
        ),
      )
      const committed = performance.now()
      const back = yield* Effect.promise(() => storage.entry(id, BACKGROUND_CONTEXT))
      const read = performance.now()
      yield* Effect.promise(() => NodeTimersPromises.setImmediate())
      turns.disable()
      console.log(
        JSON.stringify({
          megabytes,
          equal: Option.getOrThrow(Option.fromNullishOr(back)).entry.data === payload,
          commitMs: committed - started,
          readMs: read - committed,
          commitMsPerMB: (committed - started) / megabytes,
          readMsPerMB: (read - committed) / megabytes,
          peakRssMB: process.resourceUsage().maxRSS / 1024,
          longestCallbackMs,
        }),
      )
      if (Option.getOrThrow(Option.fromNullishOr(back)).entry.data !== payload)
        throw new Error('Large entry round trip differed')
    }),
  )
}
await Effect.runPromise(main())
