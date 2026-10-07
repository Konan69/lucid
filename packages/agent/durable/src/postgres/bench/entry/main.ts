import * as NodeAsyncHooks from 'node:async_hooks'
import * as NodeTimersPromises from 'node:timers/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId, EntryId } from '@earendil-works/pi-durable'
import { Config, Effect, Option, Redacted, Schema } from 'effect'
import { Pool } from 'pg'
import { openPgStorage } from '../../main.ts'

const decodeSchema = Schema.decodeUnknownSync(Schema.String)
const decodeSize = Schema.decodeUnknownSync(Schema.NumberFromString)

/** One real storage round trip in a bounded-heap child. Parent registers random
 * schema removal before spawning. Event-loop delay is measurement only, never a
 * readiness mechanism or timing assertion. No provider or shared database is used. */
async function main() {
  const url = Redacted.value(
    await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Config.Redacted('VIVID_TEST_DATABASE_URL')
      }),
    ),
  )
  if (new URL(url).port === '55433') throw new Error('Refusing developer database')
  const megabytes = decodeSize(process.argv[2])
  const schema = decodeSchema(process.argv[3])
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 })
  const storage = await openPgStorage(pool, schema)
  try {
    const conversationId = await storage.mintId<ConversationId>()
    await storage.commit(
      [{ type: 'conversation', value: { id: conversationId } }],
      BACKGROUND_CONTEXT,
    )
    const id = await storage.mintId<EntryId>()
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
    turns.enable()
    await NodeTimersPromises.setImmediate()
    const started = performance.now()
    await storage.commit(
      [{ type: 'entry', value: { id, conversationId, kind: 'large', payload } }],
      BACKGROUND_CONTEXT,
    )
    const committed = performance.now()
    const back = await storage.entry(id, BACKGROUND_CONTEXT)
    const read = performance.now()
    await NodeTimersPromises.setImmediate()
    turns.disable()
    console.log(
      JSON.stringify({
        megabytes,
        equal: Option.getOrThrow(Option.fromNullishOr(back)).entry['payload'] === payload,
        commitMs: committed - started,
        readMs: read - committed,
        commitMsPerMB: (committed - started) / megabytes,
        readMsPerMB: (read - committed) / megabytes,
        peakRssMB: process.resourceUsage().maxRSS / 1024,
        longestCallbackMs,
      }),
    )
    if (Option.getOrThrow(Option.fromNullishOr(back)).entry['payload'] !== payload)
      throw new Error('Large entry round trip differed')
  } finally {
    await storage.close(BACKGROUND_CONTEXT).finally(() => pool.end())
  }
}

await main()
