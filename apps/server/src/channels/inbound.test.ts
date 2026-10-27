import { describe, expect, layer } from '@effect/vitest'
import { RunId, RunState, ThreadId } from '@vivid/contracts'
import { Effect, Fiber, Layer, Option, Queue, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { Settlement } from '../runtime/client.ts'
import { ChannelProvider, ChannelRecipientMissing } from './provider.ts'
import { eq } from 'drizzle-orm'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentLearningLayer } from '../memory/testing.ts'
import {
  Conversation,
  DeliveryMessage,
  DeliverySpeaker,
  StoredRunOrigin,
} from '../threads/conversation.ts'
import { RunStore } from '../threads/runs.ts'
import { ThreadStore } from '../threads/store.ts'
import { deliveryRunId } from '../threads/key.ts'
import { ChannelReceiver } from './inbound.ts'
import { ChannelReplies, channelRepliesLayer } from './replies.ts'
import { ChannelStore } from './store.ts'
import { ChannelLedger } from './ledger.ts'
import { channelMessages, channelReplies } from './tables.ts'
import { ChannelControl, channelTestLayer, fixture } from './testing.ts'

/** Acquire inbound queues, settlement receipts, reply recordings and change subscriptions per case; the enclosing block shares only the database. */
const withChannels = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(channelTestLayer)
    return yield* program.pipe(Effect.provide(context))
  }).pipe(Effect.scoped)

/** Missing observations fail at their public seam instead of making assertions on undefined. */
const present = <A>(value: A) => {
  if (value === undefined) return expect.fail('Expected an observed value')
  return value
}

/** The production linking seam supplies a connected personal number before inbound delivery. */
const linked = Effect.fn('Channels.test.linked')(function* () {
  const test = yield* fixture()
  yield* (yield* ChannelStore).connect(test.actor, 'iMessage', test.address)
  yield* Ref.set((yield* ChannelControl).sends, [])
  return test
})

/** Resolve the actual admitted Run rather than manufacturing a Run or mocking Conversation. */
const started = Effect.fn('Channels.test.started')(function* (
  test: Effect.Success<ReturnType<typeof fixture>>,
) {
  const link = yield* (yield* ChannelStore).byPerson(test.actor.person.id, 'iMessage')
  if (Option.isNone(link) || Option.isNone(link.value.threadId))
    return yield* Effect.sync(() => expect.fail('No channel Thread'))
  const runs = yield* (yield* RunStore).list(link.value.threadId.value)
  const run = runs.find((value) => RunState.guards.Working(value.state))
  if (run === undefined) return yield* Effect.sync(() => expect.fail('No working channel Run'))
  return { threadId: link.value.threadId.value, run }
})

/** Inbound queues and recorded admissions belong to one case, including its restart probe. */
describe.skipIf(!testDatabaseConfigured)('channel inbound and replies', () => {
  layer(Layer.merge(testDatabaseLayer, silentLearningLayer))((it) => {
    it.effect(
      'a crash after the outbound claim and before the send leaves unknown and never resends',
      () =>
        withChannels(
          Effect.gen(function* () {
            const test = yield* linked()
            yield* test.receive('a reply whose send was interrupted')
            const first = yield* started(test)
            expect(
              Option.isSome(
                yield* (yield* ChannelLedger).claim(first.run.id, Option.some(first.run.id)),
              ),
            ).toBe(true)
            const event = yield* test.finish(first.run.id, 'A reply that must not be retried')
            yield* (yield* ChannelReplies).ended(event)
            expect(yield* Ref.get((yield* ChannelControl).sends)).toEqual([])
            const rows = yield* (yield* Database).run(
              (yield* Database)
                .select()
                .from(channelReplies)
                .where(eq(channelReplies.runId, first.run.id)),
            )
            expect(present(rows[0]).status).toBe('unknown')
          }).pipe(Effect.scoped),
        ),
    )
    it.effect('claims historic replay without opening a Thread or admitting a Run', () =>
      withChannels(
        Effect.gen(function* () {
          const test = yield* linked()
          const message = yield* test.message('historic text')
          yield* (yield* ChannelReceiver).receive({
            id: message.id,
            channel: message.channel,
            sender: message.sender,
            text: message.text,
            receivedAt: -1,
          })
          expect(yield* (yield* ThreadStore).list(test.actor)).toEqual([])
          expect(yield* Ref.get((yield* ChannelControl).admissions)).toEqual([])
          expect(yield* (yield* ChannelLedger).receive(message)).toBe(false)
        }).pipe(Effect.scoped),
      ),
    )
    it.effect('an unlinked sender is ignored and never reaches a Thread or reply transport', () =>
      withChannels(
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* test.receive('private unlinked text')
          yield* test.receive('second private text')
          expect(yield* Ref.get((yield* ChannelControl).sends)).toEqual([])
          expect(yield* (yield* ThreadStore).list(test.actor)).toEqual([])
          expect(yield* Ref.get((yield* ChannelControl).admissions)).toEqual([])
        }).pipe(Effect.scoped),
      ),
    )
    it.effect(
      'first text opens a personal Thread, later text reuses it, replay starts one Run, deletion opens a new Thread',
      () =>
        withChannels(
          Effect.gen(function* () {
            const test = yield* linked()
            const message = yield* test.message('first private channel text')
            const receiver = yield* ChannelReceiver
            yield* receiver.receive(message)
            yield* receiver.receive(message)
            const first = yield* started(test)
            expect(yield* (yield* RunStore).list(first.threadId)).toHaveLength(1)
            const admission = (yield* Ref.get((yield* ChannelControl).admissions))[0]
            expect(present(admission).message).toEqual({
              kind: 'user',
              body: 'first private channel text',
              attachments: [],
            })
            yield* test.finish(first.run.id, 'Done')
            yield* test.receive('next private text')
            const second = yield* started(test)
            expect(second.threadId).toBe(first.threadId)
            yield* test.finish(second.run.id, 'Done again')
            yield* (yield* ThreadStore).remove(test.actor.person.id, first.threadId)
            yield* test.receive('after deletion')
            expect((yield* started(test)).threadId).not.toBe(first.threadId)
            const ledger = yield* (yield* Database).run(
              (yield* Database).select().from(channelMessages),
            )
            expect(JSON.stringify(ledger)).not.toContain('private')
            expect(Object.keys(present(ledger[0]))).toEqual(['channel', 'providerId'])
          }).pipe(Effect.scoped),
        ),
    )
    /** Each chunk has a completion receipt. Productive multi-part replies may exceed one chunk's bound. */
    it.effect('delivers a progressing split reply beyond the former whole-reply deadline', () =>
      withChannels(
        Effect.gen(function* () {
          const test = yield* linked()
          const control = yield* ChannelControl
          const accepted = yield* Queue.unbounded<void>()
          yield* Ref.set(control.dispatch, Queue.take(accepted))
          yield* test.receive('please give the full answer')
          const first = yield* started(test)
          const finished = yield* test
            .finish(first.run.id, 'word '.repeat(1000))
            .pipe(Effect.forkScoped)
          yield* Queue.take(control.sending)
          yield* TestClock.adjust('20 seconds')
          yield* Queue.offer(accepted, undefined)
          yield* Queue.take(control.sending)
          yield* TestClock.adjust('20 seconds')
          yield* Queue.offer(accepted, undefined)
          yield* Fiber.join(finished)
          expect(yield* Ref.get(control.sends)).toHaveLength(2)
          const rows = yield* (yield* Database).run(
            (yield* Database)
              .select()
              .from(channelReplies)
              .where(eq(channelReplies.runId, first.run.id)),
          )
          expect(present(rows[0]).status).toBe('sent')
        }).pipe(Effect.scoped),
      ),
    )

    it.effect('a channel Run sends its plain final text once, split into bounded parts', () =>
      withChannels(
        Effect.gen(function* () {
          const test = yield* linked()
          yield* test.receive('please answer')
          const first = yield* started(test)
          const reply = `# Answer\n\n${'large reply '.repeat(900)}`
          const event = yield* test.finish(first.run.id, reply)
          yield* (yield* ChannelReplies).ended(event)
          const sends = yield* Ref.get((yield* ChannelControl).sends)
          expect(sends.length).toBeGreaterThan(1)
          expect(sends.every((send) => new TextEncoder().encode(send.text).length <= 4000)).toBe(
            true,
          )
          expect(
            sends
              .map((send) => send.text)
              .join(' ')
              .replace(/\s+/gu, ' '),
          ).toBe(`Answer ${'large reply '.repeat(900)}`.trim())
          const row = yield* (yield* Database).run(
            (yield* Database)
              .select()
              .from(channelReplies)
              .where(eq(channelReplies.runId, first.run.id)),
          )
          expect(present(row[0]).status).toBe('sent')
          expect(JSON.stringify(row)).not.toContain('large reply')
        }).pipe(Effect.scoped),
      ),
    )
    it.effect('two quick texts sharing a Flue response send that response exactly once', () =>
      withChannels(
        Effect.gen(function* () {
          const test = yield* linked()
          const control = yield* ChannelControl
          yield* test.receive('first quick text')
          const first = yield* started(test)
          yield* test.receive('second quick text')
          const submissions = yield* Ref.get(control.admissions)
          expect(submissions).toHaveLength(2)
          const second = present(submissions[1])
          const response = Settlement.cases.Completed.make({
            reply: 'One combined answer',
            responseId: first.run.id,
          })
          yield* control.finish(first.run.id, response)
          yield* control.finish(deliveryRunId(first.threadId, second.idempotencyKey), response)
          yield* Queue.take(control.endings)
          yield* Queue.take(control.endings)
          expect((yield* Ref.get(control.sends)).map((send) => send.text)).toEqual([
            'One combined answer',
          ])
        }).pipe(Effect.scoped),
      ),
    )
    it.effect('Failed, Stopped, Unknown and empty Completed outcomes are not-sent', () =>
      withChannels(
        Effect.gen(function* () {
          const test = yield* linked()
          const control = yield* ChannelControl
          for (const settlement of [
            Settlement.cases.Failed.make({ reason: 'NoAnswer' }),
            Settlement.cases.Stopped.make({}),
            Settlement.cases.Unknown.make({}),
            Settlement.cases.Completed.make({ reply: '', responseId: RunId.make('empty-reply') }),
          ]) {
            yield* test.receive('next attempt')
            const first = yield* started(test)
            yield* control.finish(first.run.id, settlement)
            yield* Queue.take(control.endings)
            const rows = yield* (yield* Database).run(
              (yield* Database)
                .select()
                .from(channelReplies)
                .where(eq(channelReplies.runId, first.run.id)),
            )
            expect(present(rows[0]).status).toBe('not-sent')
          }
          expect(yield* Ref.get(control.sends)).toEqual([])
        }).pipe(Effect.scoped),
      ),
    )
    it.effect(
      'a fresh reply service resumes a persisted route and sends by address before inbound replay',
      () =>
        withChannels(
          Effect.gen(function* () {
            const test = yield* linked()
            const store = yield* ChannelStore
            const found = yield* store.byPerson(test.actor.person.id, 'iMessage')
            if (Option.isNone(found)) {
              return yield* Effect.sync(() => expect.fail('Missing link'))
            }
            const thread = yield* (yield* ThreadStore).create(test.actor, {
              id: ThreadId.make(crypto.randomUUID()),
              title: 'Before restart',
              projectId: null,
            })
            yield* store.attach(test.actor, found.value, thread.id)
            const runId = deliveryRunId(thread.id, 'before-restart')
            yield* (yield* ChannelLedger).route({
              runId,
              threadId: thread.id,
              personId: test.actor.person.id,
              channel: 'iMessage',
              since: found.value.since,
            })
            const context = yield* Effect.context<
              Database | ChannelLedger | ChannelProvider | ChannelStore | ThreadStore
            >()
            const resumed = yield* Layer.build(
              Layer.fresh(channelRepliesLayer).pipe(Layer.provide(Layer.succeedContext(context))),
            )
            yield* Effect.gen(function* () {
              yield* (yield* ChannelReplies).ended({
                runId,
                threadId: thread.id,
                settlement: Settlement.cases.Completed.make({
                  reply: 'Resumed reply',
                  responseId: runId,
                }),
              })
            }).pipe(Effect.provideContext(resumed))
            expect(yield* Ref.get((yield* ChannelControl).sends)).toEqual([
              { channel: 'iMessage', address: test.address, text: 'Resumed reply' },
            ])
            expect(yield* Ref.get((yield* ChannelControl).admissions)).toEqual([])
          }).pipe(Effect.scoped),
        ),
    )
    it.effect(
      'a proven refusal before dispatch records not-sent, without a remembered inbound handle',
      () =>
        withChannels(
          Effect.gen(function* () {
            const test = yield* linked()
            const control = yield* ChannelControl
            yield* test.receive('please reply')
            const first = yield* started(test)
            yield* Ref.set(
              control.dispatch,
              Effect.fail(new ChannelRecipientMissing({ channel: 'iMessage' })),
            )
            yield* test.finish(first.run.id, 'A reply')
            const rows = yield* (yield* Database).run(
              (yield* Database)
                .select()
                .from(channelReplies)
                .where(eq(channelReplies.runId, first.run.id)),
            )
            expect(present(rows[0]).status).toBe('not-sent')
            expect(yield* Ref.get(control.sends)).toEqual([])
          }).pipe(Effect.scoped),
        ),
    )
    it.effect('a Run started from the app sends nothing to the channel', () =>
      withChannels(
        Effect.gen(function* () {
          const test = yield* linked()
          yield* test.receive('from channel')
          const first = yield* started(test)
          yield* test.finish(first.run.id, 'Channel result')
          yield* Ref.set((yield* ChannelControl).sends, [])
          const key = 'app-message'
          yield* (yield* Conversation).admit({
            threadId: first.threadId,
            personId: test.actor.person.id,
            speaker: DeliverySpeaker.cases.Acting.make({}),
            origin: StoredRunOrigin.cases.Message.make({}),
            message: DeliveryMessage.cases.Said.make({ body: 'app text' }),
            idempotencyKey: key,
          })
          yield* test.finish(deliveryRunId(first.threadId, key), 'App result')
          expect(yield* Ref.get((yield* ChannelControl).sends)).toEqual([])
        }).pipe(Effect.scoped),
      ),
    )
  })
  layer(Layer.merge(testDatabaseLayer, silentLearningLayer))(
    'Clock for a hung send times out with unknown evidence and never retries',
    (it) => {
      it.effect('a hung send times out with unknown evidence and never retries', () =>
        withChannels(
          Effect.gen(function* () {
            const test = yield* linked()
            const control = yield* ChannelControl
            yield* test.receive('please reply')
            const first = yield* started(test)
            yield* Ref.set(control.dispatch, Effect.never)
            const finished = yield* test.finish(first.run.id, 'A reply').pipe(Effect.forkScoped)
            yield* Queue.take(control.sending)
            yield* TestClock.adjust('29999 millis')
            expect(finished.pollUnsafe()).toBeUndefined()
            yield* TestClock.adjust('1 millis')
            const event = yield* Fiber.join(finished)
            yield* (yield* ChannelReplies).ended(event)
            const rows = yield* (yield* Database).run(
              (yield* Database)
                .select()
                .from(channelReplies)
                .where(eq(channelReplies.runId, first.run.id)),
            )
            expect(present(rows[0]).status).toBe('unknown')
            expect(yield* Ref.get(control.sends)).toEqual([])
          }).pipe(Effect.scoped),
        ),
      )
    },
  )
})
