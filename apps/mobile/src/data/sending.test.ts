import { describe, expect, it } from '@effect/vitest'
import { RpcConnection, VividRpcClient } from '@vivid/client-runtime'
import {
  PersonId,
  RunId,
  RunOrigin,
  RunState,
  RuntimeUnavailable,
  ThreadAudience,
  ThreadId,
  type ThreadResponse,
} from '@vivid/contracts'
import { makeLive, sending } from '@vivid/state'
import { VividRpc } from '@vivid/contracts/rpc'
import { Data, Effect, Exit, Fiber, Layer, Option, Predicate, Queue, Ref } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import {
  again,
  begin,
  First,
  FirstDelivery,
  firstKey,
  isOnItsWay,
  makeFirsts,
  withFirst,
  type Way,
} from './first'
import { makeSending } from './sending'

const thread = ThreadId.make('phone-first')
const person = { id: PersonId.make('ada'), name: 'Ada', image: null }
const first = { words: 'A', projectId: null }
const second: sending.Delivery = { thread, key: 'B', words: 'B', pictures: [] }
const seen: sending.Seen = { shown: [], ended: [] }

/** SDK exits have no constructor; derive this transport constructor from its public envelope type. */
const Response = Data.taggedEnum<
  Data.TaggedEnum<{
    Exit: Omit<RpcMessage.ResponseExit<RpcGroup.Rpcs<typeof VividRpc>>, '_tag'>
  }>
>()

/** Real phone sending and live adapters, with only the typed server endpoints answered by hand. */
const phone = Effect.fn('PhoneSendingTest.phone')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.Request<RpcGroup.Rpcs<typeof VividRpc>>>()
  const awaiting = yield* Ref.make(
    Option.none<RpcMessage.Request<RpcGroup.Rpcs<typeof VividRpc>>>(),
  )
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) =>
      Predicate.isTagged(message, 'Request')
        ? Queue.offer(requests, message).pipe(Effect.asVoid)
        : Effect.void,
  })
  /** Observe the generated request and preserve its transport identity through a hand answer. */
  const request = Effect.fn('PhoneSendingTest.request')(function* (
    tag: 'CreateThread' | 'SendToThread',
  ) {
    const next = yield* Queue.take(requests)
    expect(next.tag).toBe(tag)
    yield* Ref.set(awaiting, Option.some(next))
    return next.payload
  })
  /** Replies use the SDK envelope and Exit; the generated client owns all call options. */
  const reply = Effect.fn('PhoneSendingTest.reply')(function* (
    tag: 'CreateThread' | 'SendToThread',
    exit: RpcMessage.ResponseExit<RpcGroup.Rpcs<typeof VividRpc>>['exit'],
  ) {
    const held = yield* Ref.get(awaiting)
    if (Option.isNone(held)) expect.fail('An RPC request must be observed before it is answered')
    expect(held.value.tag).toBe(tag)
    yield* rpc.write(
      Response.Exit({
        clientId: 0,
        requestId: held.value.id,
        exit,
      }),
    )
  })
  const engine = makeLive(
    Layer.merge(
      Layer.succeed(VividRpcClient, rpc.client),
      Layer.succeed(RpcConnection, { ready: Effect.void }),
    ),
  )
  yield* Effect.addFinalizer(() => Effect.sync(() => engine.registry.dispose()))
  const client = makeSending(engine)
  /** Observe the registry's own publication, including queued events that invoked no endpoint. */
  const at = (path: Parameters<typeof sending.SendingStates.matches>[1]) =>
    Effect.callback<sending.SendingState>((resume) => {
      const check = () => {
        const current = engine.registry.get(client.stateIn(thread))
        if (!Option.isSome(current) || !sending.SendingStates.matches(current.value, path)) return
        stop()
        resume(Effect.succeed(current.value))
      }
      const stop = engine.registry.subscribe(client.stateIn(thread), check)
      check()
      return Effect.sync(stop)
    })
  /** Wait for B to enter the creation queue before checking its ordering or calling Stop. */
  const queued = Effect.callback<void>((resume) => {
    const check = () => {
      const current = engine.registry.get(client.stateIn(thread))
      const creating = Option.flatMap(current, (state) =>
        sending.SendingStates.get(state, 'Creating'),
      )
      if (
        !Option.exists(creating, (state) => state.behind.some((delivery) => delivery.key === 'B'))
      )
        return
      stop()
      resume(Effect.void)
    }
    const stop = engine.registry.subscribe(client.stateIn(thread), check)
    check()
    return Effect.sync(stop)
  })
  const created: ThreadResponse = {
    thread: {
      id: thread,
      title: 'A',
      projectId: null,
      preview: '',
      updatedAt: 0,
      archived: false,
      createdBy: person,
      audience: ThreadAudience.cases.Private.make({}),
      attention: 'Quiet',
    },
  }
  const answer = (key: string, terminal: boolean) =>
    reply(
      'SendToThread',
      Exit.succeed({
        run: {
          id: RunId.make(`run-${key}`),
          threadId: thread,
          turn: 1,
          startedAt: 0,
          origin: RunOrigin.cases.Message.make({ person }),
          state: terminal
            ? RunState.cases.Stopped.make({ finishedAt: 1 })
            : RunState.cases.Working.make({}),
        },
      }),
    )
  return {
    client,
    engine,
    at,
    queued,
    creation: request('CreateThread'),
    delivery: request('SendToThread'),
    created: reply('CreateThread', Exit.succeed(created)),
    refused: reply('CreateThread', Exit.fail(RuntimeUnavailable.make({ message: 'Receipt lost' }))),
    undelivered: reply(
      'SendToThread',
      Exit.fail(RuntimeUnavailable.make({ message: 'Receipt lost' })),
    ),
    answer,
  }
})

/** The greeting uses the same registry and machine as the composer, with composer receipts recorded. */
const greeting = (made: {
  readonly engine: ReturnType<typeof makeLive>
  readonly client: ReturnType<typeof makeSending>
}) => {
  const feedback: Array<string> = []
  const firsts = makeFirsts()
  const outcome = (admitted: sending.Admission): FirstDelivery =>
    sending.Admission.match<FirstDelivery>(admitted, {
      Accepted: ({ submission }) => FirstDelivery.Accepted({ submission }),
      Uncreated: () => FirstDelivery.Uncreated({ why: 'Not delivered' }),
      Unanswered: () => FirstDelivery.Unanswered({ why: 'Not delivered' }),
    })
  const way: Way = {
    registry: made.engine.registry,
    stateIn: made.client.stateIn,
    unanswered: 'Not delivered',
    begin: (id, start) => made.client.beginFirst(id, start).then(outcome),
    again: (id) => made.client.againFirst(id).then(outcome),
    returned: () => {
      feedback.push('returned')
    },
    taken: () => {
      feedback.push('taken')
    },
  }
  return { firsts, way, feedback }
}

describe('phone first words and follow-ups', () => {
  it.effect('drops refused first words after different words and ignores their stale retry', () =>
    Effect.gen(function* () {
      const made = yield* phone()
      const { firsts, way, feedback } = greeting(made)
      const begun = yield* Effect.forkChild(
        begin(way, firsts, thread, { ...first, at: 0, place: 'greeting' }),
      )
      yield* made.creation
      yield* made.created
      yield* made.delivery
      yield* made.undelivered
      yield* Fiber.join(begun)
      expect(Option.exists(firsts.of(thread), First.$is('Unsent'))).toBe(true)
      expect(feedback).toEqual(['returned'])
      const said = made.client.say({ delivery: second, seen })
      yield* made.delivery
      expect(firsts.of(thread)).toEqual(Option.none())
      expect(firsts.all().size).toBe(0)
      yield* again(way, firsts, thread)
      expect(isOnItsWay(firsts.of(thread), false)).toBe(false)
      yield* made.answer('B', false)
      expect(yield* Effect.promise(() => said)).toBe(true)
    }),
  )

  it.effect(
    'keeps A and B through Stop during creation and retries them under their original keys',
    () =>
      Effect.gen(function* () {
        const made = yield* phone()
        const firstReceipt = made.client.beginFirst(thread, first)
        expect(yield* made.creation).toEqual({ id: thread, title: 'A', projectId: null })
        const secondReceipt = made.client.say({ delivery: second, seen })
        yield* made.queued
        made.client.stopped(thread)
        yield* made.at('Uncreated')
        expect(yield* Effect.promise(() => firstReceipt)).toEqual(
          sending.Admission.cases.Uncreated.make({ why: Option.none() }),
        )
        expect(yield* Effect.promise(() => secondReceipt)).toBe(false)
        const retried = made.client.againFirst(thread)
        expect(yield* made.creation).toEqual({ id: thread, title: 'A', projectId: null })
        yield* made.created
        expect(yield* made.delivery).toEqual({
          threadId: thread,
          key: firstKey(thread),
          text: 'A',
          pictures: [],
        })
        yield* made.answer('A', false)
        expect(yield* Effect.promise(() => retried)).toEqual(
          sending.Admission.cases.Accepted.make({ submission: Option.none() }),
        )
        expect(yield* made.delivery).toEqual({
          threadId: thread,
          key: 'B',
          text: 'B',
          pictures: [],
        })
        yield* made.answer('B', false)
        const idle = yield* made.at('Idle')
        expect(
          sending
            .drawing({
              messages: [],
              live: true,
              sending: Option.some(idle),
              runs: [],
              ahead: true,
            })
            .said.map((message) => message.key),
        ).toEqual([firstKey(thread), 'B'])
      }),
  )

  it.effect('retains the creation queue after a lost receipt and hands over A before B', () =>
    Effect.gen(function* () {
      const made = yield* phone()
      const { firsts, way, feedback } = greeting(made)
      const firstReceipt = yield* Effect.forkChild(
        begin(way, firsts, thread, { ...first, at: 0, place: 'greeting' }),
      )
      yield* made.creation
      expect(Option.exists(firsts.of(thread), First.$is('Sending'))).toBe(true)
      const secondReceipt = made.client.say({ delivery: second, seen })
      yield* made.queued
      yield* made.refused
      const failed = yield* made.at('Uncreated')
      yield* Fiber.join(firstReceipt)
      expect(firsts.of(thread)).toEqual(
        Option.some(
          First.Unsent({
            start: { ...first, at: 0, place: 'greeting' },
            why: 'Receipt lost',
          }),
        ),
      )
      expect(feedback).toEqual(['returned'])
      expect(yield* Effect.promise(() => secondReceipt)).toBe(false)
      expect(
        sending
          .drawing({
            messages: [],
            live: true,
            sending: Option.some(failed),
            runs: [],
            ahead: true,
          })
          .unsent.map((one) => one.delivery.key),
      ).toEqual([firstKey(thread), 'B'])
      const retried = yield* Effect.forkChild(again(way, firsts, thread))
      expect(yield* made.creation).toEqual({ id: thread, title: 'A', projectId: null })
      yield* made.created
      expect(yield* made.delivery).toEqual({
        threadId: thread,
        key: firstKey(thread),
        text: 'A',
        pictures: [],
      })
      yield* made.answer('A', false)
      yield* Fiber.join(retried)
      expect(firsts.of(thread)).toEqual(
        Option.some(
          First.Said({
            start: { ...first, at: 0, place: 'greeting' },
            submission: Option.none(),
          }),
        ),
      )
      expect(feedback).toEqual(['returned', 'taken'])
      yield* again(way, firsts, thread)
      expect(feedback).toEqual(['returned', 'taken'])
      expect(yield* made.delivery).toEqual({ threadId: thread, key: 'B', text: 'B', pictures: [] })
      yield* made.answer('B', false)
      yield* made.at('Idle')
    }),
  )

  it.effect('retains first echo ownership after releasing payloads and sharing the Thread', () =>
    Effect.gen(function* () {
      const made = yield* phone()
      const receipt = made.client.beginFirst(thread, first)
      yield* made.creation
      yield* made.created
      yield* made.delivery
      made.client.stopped(thread)
      const stopped = yield* made.at('Idle')
      expect(yield* Effect.promise(() => receipt)).toEqual(
        sending.Admission.cases.Unanswered.make({}),
      )
      const echo = {
        id: 'entry-7',
        role: 'user' as const,
        purpose: 'user' as const,
        display: 'visible' as const,
        key: firstKey(thread),
        parts: [{ type: 'text' as const, text: 'A', state: 'done' as const }],
      }
      const privateDrawing = sending.drawing({
        messages: [echo],
        live: true,
        sending: Option.some(stopped),
        runs: [],
        ahead: true,
      })
      const secondReceipt = made.client.say({ delivery: second, seen: privateDrawing.seen })
      expect(yield* made.delivery).toEqual({ threadId: thread, key: 'B', text: 'B', pictures: [] })
      yield* made.answer('B', false)
      expect(yield* Effect.promise(() => secondReceipt)).toBe(true)
      const idle = yield* made.at('Idle')
      const collision = {
        ...echo,
        id: 'entry-6',
        parts: [{ type: 'text' as const, text: 'From Dami', state: 'done' as const }],
      }
      const shared = sending.drawing({
        messages: [collision, echo],
        live: true,
        sending: Option.some(idle),
        runs: [],
        ahead: false,
      })
      const recognised = Option.map(
        Option.fromUndefinedOr(shared.seen.shown.find((proof) => proof.key === firstKey(thread))),
        sending.sentId,
      )
      const held = Option.some(
        First.Unsent({
          start: { ...first, at: 0, place: 'greeting' },
          why: 'Receipt lost',
        }),
      )
      expect(
        withFirst(thread, held, shared.said, { privateThread: false, recognised }).map(
          (message) => message.id,
        ),
      ).toEqual(['entry-6', firstKey(thread)])
      expect(shared.unsent).toEqual([])
    }),
  )

  it.effect('accepts a terminal receiptless first Run without offering it as unanswered', () =>
    Effect.gen(function* () {
      const made = yield* phone()
      const receipt = made.client.beginFirst(thread, first)
      yield* made.creation
      yield* made.created
      expect(yield* made.delivery).toEqual({
        threadId: thread,
        key: firstKey(thread),
        text: 'A',
        pictures: [],
      })
      yield* made.answer('A', true)
      expect(yield* Effect.promise(() => receipt)).toEqual(
        sending.Admission.cases.Accepted.make({ submission: Option.none() }),
      )
      const idle = yield* made.at('Idle')
      const drawn = sending.drawing({
        messages: [],
        live: true,
        sending: Option.some(idle),
        runs: [],
        ahead: true,
      })
      expect(drawn.unsent).toEqual([])
      expect(drawn.owed).toBe(false)
      expect(drawn.said).toEqual([])
    }),
  )
})
