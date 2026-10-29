import { describe, expect, layer } from '@effect/vitest'
import {
  CreateWatchRequest,
  ForgetChange,
  ForgetRemaining,
  MemoryAddress,
  MemoryCitation,
  MemoryClosed,
  MemoryFile,
  MemoryForgetReceipt,
  MemoryRevision,
  MemoryScope,
  MemorySource,
  MessageId,
  PersonId,
  SavedMemory,
  ThreadId,
  WatchState,
  type MemoryClosure,
} from '@vivid/contracts'
import { Array as Arr, Clock, Context, Effect, Layer, Option, Queue, Ref } from 'effect'
import type { Actor } from '../auth/access.ts'
import { auditLayer } from '../audit/record.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { owedStoreLayer } from '../owed/store.ts'
import { CellMemory } from '../runtime/client.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { ThreadStore } from '../threads/store.ts'
import { Watches } from '../watches/lifecycle.ts'
import { WatchStore } from '../watches/store.ts'
import { Delivered, Executor, person, testLayer as watchLayer } from '../watches/testing.ts'
import { carryOut, forgetFromSettings, planForget } from './close.ts'
import { ForgetStore, forgetStoreLayer } from './store.ts'

const address = MemoryAddress.make({ layer: 'memory', file: MemoryFile.make('visa.md') })

const closed = (remaining: MemoryClosed['remaining']) =>
  MemoryClosed.make({ retracted: 1, rewritten: 0, learning: 2, remaining })

/** What the stand-in cell answers in one case, and every closure it was sent. */
interface CellScript {
  readonly cited: Ref.Ref<ThreadId>
  readonly answer: Ref.Ref<MemoryClosed>
  readonly closures: Ref.Ref<ReadonlyArray<MemoryClosure>>
}
class Cell extends Context.Service<Cell, CellScript>()('test/ForgetCell') {}

/**
 * The Person's cell, as the server reaches it over HTTP (`runtime/client.ts` `CellMemory`): one
 * saved entry at revision 1 citing the scripted Thread, and the scripted closure answer. The
 * cell's own half (learning stopped, entries retracted and read back) is proved against a real
 * cell in `packages/agent/runtime/src/forget.test.ts`; here only its wire answer stands in.
 */
const cellLayer = Layer.effectContext(
  Effect.gen(function* () {
    const script: CellScript = {
      cited: yield* Ref.make(ThreadId.make('unset')),
      answer: yield* Ref.make(closed([])),
      closures: yield* Ref.make<ReadonlyArray<MemoryClosure>>([]),
    }
    const cell = CellMemory.of({
      index: () => Effect.die('not read in this test'),
      list: () => Effect.die('not read in this test'),
      read: (_person, input) =>
        Effect.map(Ref.get(script.cited), (cited) =>
          SavedMemory.make({
            ...input,
            kind: 'fact',
            description: 'Dana’s visa appointment',
            body: 'Dana has a visa appointment on Friday.',
            basis: 'said',
            scope: MemoryScope.cases.Personal.make({}),
            revision: MemoryRevision.make(1),
            updatedAt: 0,
            authority: {
              actor: PersonId.make('memory-owner'),
              source: MemorySource.cases.Settings.make({ at: 0 }),
            },
            citations: [
              MemoryCitation.cases.ThreadMessage.make({
                threadId: cited,
                messageId: MessageId.make('entry-2'),
              }),
            ],
          }),
        ),
      write: () => Effect.die('not written in this test'),
      retract: () => Effect.die('not retracted in this test'),
      close: (_person, closure) =>
        Ref.update(script.closures, (all) => [...all, closure]).pipe(
          Effect.andThen(Ref.get(script.answer)),
        ),
    })
    return Context.make(CellMemory, cell).pipe(Context.add(Cell, script))
  }),
)

/** Set what the cell answers for this case. */
const script = Effect.fn('ForgetTest.script')(function* (cited: ThreadId, answer: MemoryClosed) {
  const cell = yield* Cell
  yield* Ref.set(cell.cited, cited)
  yield* Ref.set(cell.answer, answer)
  yield* Ref.set(cell.closures, [])
  return cell
})

/** A Watch whose instruction uses the fact, granted by the stand-in Executor. */
const visaWatch = Effect.fn('ForgetTest.visaWatch')(function* (actor: Actor) {
  const executor = yield* Executor
  const now = yield* Clock.currentTimeMillis
  yield* Queue.offer(executor.answers, {
    id: `evs_${'1'.repeat(32)}`,
    refreshBefore: new Date(now + 3_600_000),
  })
  const watch = yield* (yield* Watches).create(
    actor,
    CreateWatchRequest.make({
      name: 'Dana visa mail',
      account: 'mail (work)',
      event: 'message.received',
      arguments: { folder: 'inbox' },
      instruction: 'When Dana writes about her visa appointment, remind me the day before.',
    }),
  )
  yield* Queue.take(executor.subscribed)
  return watch
})

/** The Person's own conversation, and Vivid acting in it. */
const conversation = Effect.fn('ForgetTest.conversation')(function* (actor: Actor) {
  const thread = yield* (yield* ThreadStore).ensureBackground({
    id: ThreadId.make(`forget-test-${crypto.randomUUID()}`),
    title: 'Visa',
    titleSource: 'Assigned',
    personId: actor.person.id,
    companyId: null,
  })
  const vivid: Actor = { ...actor, by: 'vivid', threadId: Option.some(thread.id) }
  return { thread, vivid }
})

const stateOf = Effect.fn('ForgetTest.stateOf')(function* (
  id: Parameters<WatchStore['Service']['find']>[0],
) {
  const found = yield* (yield* WatchStore).find(id)
  return Option.map(found, (record) => record.watch.state)
})

const testLayer = Layer.mergeAll(forgetStoreLayer, owedStoreLayer, auditLayer, cellLayer).pipe(
  Layer.provideMerge(watchLayer),
)

describe.skipIf(!testDatabaseConfigured)('Forgetting closes what was built on a memory', () => {
  layer(testLayer)((it) => {
    it.effect('stops a Watch whose instruction uses the fact and answers Completed', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const watch = yield* visaWatch(actor)
        const { thread, vivid } = yield* conversation(actor)
        const cell = yield* script(thread.id, closed([]))
        const { plan, receipt } = yield* Effect.gen(function* () {
          const plan = yield* planForget(vivid, {
            changes: [
              ForgetChange.cases.Retract.make({ address, expected: MemoryRevision.make(1) }),
            ],
            watches: [watch.id],
            owed: [],
          })
          expect(plan.shared).toEqual([])
          return { plan, receipt: yield* carryOut(vivid) }
        })
        expect(MemoryForgetReceipt.guards.Completed(receipt)).toBe(true)
        expect(MemoryForgetReceipt.guards.Completed(receipt) && receipt.done).toEqual({
          retracted: 1,
          rewritten: 0,
          watches: 1,
          owed: 0,
          learning: 2,
        })
        expect(yield* stateOf(watch.id)).toEqual(
          Option.some(WatchState.cases.Stopped.make({ reason: 'removed' })),
        )
        expect(yield* Ref.get((yield* Executor).unsubscribed)).toContain('mail.message.received')
        expect(yield* Ref.get(cell.closures)).toMatchObject([
          {
            writer: thread.id,
            authority: { source: MemorySource.cases.Forget.make({ forgetId: plan.id }) },
          },
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('answers Blocked with what it could not stop', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const other = yield* person()
        const { vivid } = yield* conversation(actor)
        // The fact was learned in a Thread another Person created: its learning is in their cell.
        const { thread: theirs } = yield* conversation(other)
        const reply = ForgetRemaining.cases.Reply.make({ threadId: ThreadId.make('busy-thread') })
        yield* script(theirs.id, closed([reply]))
        const receipt = yield* Effect.gen(function* () {
          yield* planForget(vivid, {
            changes: [
              ForgetChange.cases.Retract.make({ address, expected: MemoryRevision.make(1) }),
            ],
            watches: [],
            owed: [],
          })
          return yield* carryOut(vivid)
        })
        expect(MemoryForgetReceipt.guards.Blocked(receipt) && receipt.remaining).toEqual([
          reply,
          ForgetRemaining.cases.SharedLearning.make({ threadId: theirs.id }),
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('hands a Settings press to Vivid and follows it to its receipt', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        yield* script(ThreadId.make('no-thread'), closed([]))
        const result = yield* Effect.gen(function* () {
          const pending = yield* forgetFromSettings(actor, address, MemoryRevision.make(1))
          const delivered = yield* Ref.get(yield* Delivered)
          expect(delivered).toMatchObject([{ origin: StoredRunOrigin.cases.Forget.make({}) }])
          const background = Option.map(Arr.head(delivered), (value) => value.threadId)
          const vivid: Actor = { ...actor, by: 'vivid', threadId: background }
          const store = yield* ForgetStore
          expect(yield* store.receipt(actor.person.id, pending.id)).toEqual(pending)
          const plan = yield* planForget(vivid, {
            changes: [
              ForgetChange.cases.Retract.make({ address, expected: MemoryRevision.make(1) }),
            ],
            watches: [],
            owed: [],
          })
          expect(plan.id).toBe(pending.id)
          const done = yield* carryOut(vivid)
          return { pending, done, read: yield* store.receipt(actor.person.id, pending.id) }
        })
        expect(MemoryForgetReceipt.guards.Pending(result.pending)).toBe(true)
        expect(MemoryForgetReceipt.guards.Completed(result.done)).toBe(true)
        expect(result.read).toEqual(result.done)
      }).pipe(Effect.scoped),
    )
  })
})
