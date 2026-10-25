import { describe, expect, it } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { MachineTest } from '@typeonce/effect-machine/testing'
import {
  PersonId,
  type CreateThreadRequest,
  RunId,
  RunOrigin,
  RunState,
  ThreadId,
  type ConversationMessage,
  type ConversationState,
  type Run,
} from '@vivid/contracts'
import { Effect, Layer, Option, Queue, Result } from 'effect'
import { AsyncResult, AtomRegistry } from 'effect/reactivity'
import {
  arrivalOf,
  begin as beginInRegistry,
  Delivering,
  drawing,
  isWaiting,
  isWorking,
  makeSending,
  send,
  Sending,
  SendingEvents,
  SendingStates,
  sentId,
  stateOf,
  Undelivered,
  type Delivery,
  type Drawing,
  type Seen,
  type SendingState,
} from './sending.ts'

const thread = ThreadId.make('t1')

const delivery = (key: string, words: string): Delivery => ({ thread, key, words, pictures: [] })
const note = delivery('k1', 'Draft the note')
const more = delivery('k2', 'And send it to Ada')

const working = RunState.cases.Working.make({})
const stopped = RunState.cases.Stopped.make({ finishedAt: 2 })

/** The Run the server answers a delivery with: its own id, and its number in the runtime. */
const run = (id: string, submission: string, state: Run['state'] = working): Run => ({
  id: RunId.make(id),
  submissionId: submission,
  threadId: thread,
  turn: Number(submission),
  origin: RunOrigin.cases.Message.make({
    person: { id: PersonId.make('ada'), name: 'Ada Obi', image: null },
  }),
  state,
  startedAt: Number(submission),
})

/** A Person's message as the conversation shows it, with the key it was sent under. */
const placed = (id: string, text: string, key: string): ConversationMessage => ({
  id,
  role: 'user',
  purpose: 'user',
  display: 'visible',
  key,
  parts: [{ type: 'text', text, state: 'done' }],
})

/** A Person's message from before messages carried a key, or placed by the server itself. */
const keyless = (id: string, text: string): ConversationMessage => ({
  id,
  role: 'user',
  purpose: 'user',
  display: 'visible',
  parts: [{ type: 'text', text, state: 'done' }],
})

/** Vivid's reply. A reply never carries a key. */
const reply = (id: string, text: string): ConversationMessage => ({
  id,
  role: 'assistant',
  purpose: 'assistant',
  display: 'visible',
  parts: [{ type: 'text', text, state: 'done' }],
})

/** A conversation with nothing said: at rest unless a case says. */
const conversation = (isWorkingNow: boolean): ConversationState => ({
  messages: [],
  settlements: [],
  queued: 0,
  working: isWorkingNow,
})

/** What a private Thread draws, with these Runs listed. A shared Thread calls `drawing`. */
const draw = (
  state: SendingState,
  messages: ReadonlyArray<ConversationMessage> = [],
  runs: ReadonlyArray<Run> = [],
  at: { readonly live: boolean } = { live: true },
): Drawing => drawing({ messages, live: at.live, sending: Option.some(state), runs, ahead: true })

/** What a sender says it has seen when it has looked at nothing. */
const NOTHING_SEEN: Seen = { shown: [], ended: [] }

/** The words of each message drawn, with the id it is drawn under. */
const rows = (drawn: Drawing) =>
  drawn.said.map((message) => [
    message.id,
    message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' '),
  ])

/** What is offered to be sent again, by key. */
const unsentKeys = (drawn: Drawing) => drawn.unsent.map((failed) => failed.delivery.key)

/**
 * The machine against a server the test answers by hand: each delivery handed to the server
 * takes the next answer the test hands over, in order, whether the answer was handed over before
 * the delivery was made or after. `asked` is every delivery made, in order, and `dropped` says
 * each time a call was called off before it was answered.
 */
const started = Effect.fn('SendingTest.started')(function* () {
  const asked: Array<Delivery> = []
  const answers = yield* Queue.unbounded<Result.Result<Run, Undelivered>>()
  const dropped = yield* Queue.unbounded<string>()
  const creations = yield* Queue.unbounded<CreateThreadRequest>()
  const created = yield* Queue.unbounded<Result.Result<void, Undelivered>>()
  const abandoned = yield* Queue.unbounded<ThreadId>()
  const server = Layer.succeed(Delivering, {
    create: (request) =>
      Effect.andThen(
        Queue.offer(creations, request),
        Effect.flatMap(Queue.take(created), Effect.fromResult),
      ).pipe(Effect.onInterrupt(() => Queue.offer(abandoned, request.id))),
    send: (made) =>
      Effect.suspend(() => {
        asked.push(made)
        return Effect.flatMap(Queue.take(answers), Effect.fromResult)
      }).pipe(Effect.onInterrupt(() => Queue.offer(dropped, made.key))),
  })
  const ref = yield* Machine.start(Sending).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- Each case answers its own server by hand, so the service is built for the one machine a case starts and holds no resource.
    Effect.provide(server),
  )
  const probe = yield* MachineTest.probe(Sending, ref)
  const at = (path: Parameters<typeof SendingStates.matches>[1]) =>
    Machine.waitFor(ref, (snapshot) => SendingStates.matches(snapshot.state, path))
  const say = (made: Delivery, seen: Seen = NOTHING_SEEN) =>
    probe.sendAndAwait(SendingEvents.Send({ delivery: made, seen }))
  return {
    asked,
    begin: () =>
      probe.sendAndAwait(
        SendingEvents.Begin({
          creation: { id: thread, title: 'Draft the note', projectId: null },
          delivery: note,
        }),
      ),
    creation: Queue.take(creations),
    created: Queue.offer(created, Result.succeed(undefined)),
    creationFailed: Queue.offer(
      created,
      Result.fail(new Undelivered({ why: Option.some('Receipt lost') })),
    ),
    abandoned: Queue.take(abandoned),
    keys: () => asked.map((made) => made.key),
    probe,
    at,
    send: say,
    again: (seen: Seen = NOTHING_SEEN) => probe.sendAndAwait(SendingEvents.Again({ seen })),
    stop: probe.sendAndAwait(SendingEvents.Stop()),
    dropped: Queue.take(dropped),
    take: (answer: Run) => Queue.offer(answers, Result.succeed(answer)),
    refuse: (why: Option.Option<string>) =>
      Queue.offer(answers, Result.fail(new Undelivered({ why }))),
    /** The machine at rest once the server has taken `made` as `answer`. */
    taken: (made: Delivery, answer: Run) =>
      Effect.gen(function* () {
        yield* say(made)
        yield* Queue.offer(answers, Result.succeed(answer))
        return (yield* at('Idle')).state
      }),
  }
})

describe('sending in a Thread', () => {
  it.effect('draws the words the moment they are sent, before the server has answered', () =>
    Effect.gen(function* () {
      const made = yield* started()
      const sent = yield* made.send(note)
      expect(sent.handled).toBe(true)
      expect(isWaiting(Option.some(sent.after))).toBe(true)
      const drawn = draw(sent.after)
      expect(rows(drawn)).toEqual([[sentId(note), 'Draft the note']])
      expect(drawn.owed).toBe(true)
      // A shared Thread's message comes back from the server saying who spoke; nothing is drawn
      // ahead of that, and the send is owed all the same.
      const shared = drawing({
        messages: [],
        live: true,
        sending: Option.some(sent.after),
        runs: [],
        ahead: false,
      })
      expect(shared.said).toEqual([])
      expect(shared.owed).toBe(true)
      expect(made.asked).toEqual([note])
    }),
  )

  it.effect(
    'goes on drawing the words once the server has taken them, until the conversation has their message',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        const state = yield* made.taken(note, run('run-a', '7'))
        expect(isWaiting(Option.some(state))).toBe(false)
        // Vivid's earlier reply is there; the delivery's own message is not yet.
        const drawn = draw(state, [reply('run-3', 'Hello')])
        expect(rows(drawn)).toEqual([
          ['run-3', 'Hello'],
          [sentId(note), 'Draft the note'],
        ])
        expect(drawn.owed).toBe(true)
      }),
  )

  it.effect(
    'is the conversation’s own message once it carries the key: the same row, once, and nothing kept',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        const state = yield* made.taken(note, run('run-a', '7'))
        const echo = placed('entry-12', 'Draft the note', 'k1')
        const answer = reply('run-13', 'Here it is')
        const drawn = draw(state, [echo, answer])
        expect(rows(drawn)).toEqual([
          [sentId(note), 'Draft the note'],
          ['run-13', 'Here it is'],
        ])
        expect(drawn.owed).toBe(false)
        // The row is the same object for as long as the message is: nothing is drawn again.
        expect(draw(state, [echo, answer]).said[0]).toBe(drawn.said[0])
        // The conversation showing it is all that is needed: said with the next send, the
        // machine holds nothing of the delivery, and the row is the row it was.
        expect(drawn.seen).toEqual({
          ended: [],
          shown: [{ key: 'k1', message: 'entry-12', submission: Option.none() }],
        })
        const next = yield* made.send(more, drawn.seen)
        expect(JSON.stringify(next.after)).not.toContain('Draft the note')
        expect(rows(draw(next.after, [echo, answer]))).toEqual([
          [sentId(note), 'Draft the note'],
          ['run-13', 'Here it is'],
          [sentId(more), 'And send it to Ada'],
        ])
      }),
  )

  it.effect('draws the words once when the conversation has them before the server’s answer', () =>
    Effect.gen(function* () {
      const made = yield* started()
      const sent = yield* made.send(note)
      const echo = placed('entry-12', 'Draft the note', 'k1')
      const early = draw(sent.after, [echo])
      expect(rows(early)).toEqual([[sentId(note), 'Draft the note']])
      // The answer then arrives: the same row, the same object.
      yield* made.take(run('run-a', '7'))
      const state = (yield* made.at('Idle')).state
      expect(draw(state, [echo]).said[0]).toBe(early.said[0])
    }),
  )

  it.effect(
    'knows its own message by its key alone: never by its words, its number or where it stands',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        yield* made.send(delivery('k1', 'Yes'))
        const sent = yield* made.send(delivery('k2', 'Yes'))
        // The same words said earlier, said from another device under its own key, and said
        // with spaces around them: none of them is either of these deliveries.
        const others = [
          keyless('entry-2', 'Yes'),
          placed('entry-9', 'Yes', 'from-my-phone'),
          placed('entry-10', ' Yes ', 'another'),
        ]
        expect(rows(draw(sent.after, others))).toEqual([
          ['entry-2', 'Yes'],
          ['entry-9', 'Yes'],
          ['entry-10', ' Yes '],
          ['sent:k1', 'Yes'],
          ['sent:k2', 'Yes'],
        ])
        // The second's message arrives first: it is the second's, and the first still waits.
        const drawn = draw(sent.after, [...others, placed('entry-14', 'Yes', 'k2')])
        expect(rows(drawn).slice(3)).toEqual([
          ['sent:k2', 'Yes'],
          ['sent:k1', 'Yes'],
        ])
        expect(drawn.owed).toBe(true)
      }),
  )

  it.effect('keeps words that did not arrive, with the server’s sentence when it gave one', () =>
    Effect.gen(function* () {
      const made = yield* started()
      yield* made.send(note)
      yield* made.refuse(Option.some('Vivid is still answering Dami.'))
      const state = (yield* made.at('Idle')).state
      const drawn = draw(state)
      expect(drawn.unsent).toEqual([
        { delivery: note, why: Option.some('Vivid is still answering Dami.') },
      ])
      // They stay where they were drawn; the screen marks them from `unsent`. Nothing is on its
      // way and Vivid is not at work on them.
      expect(rows(drawn)).toEqual([[sentId(note), 'Draft the note']])
      expect(drawn.owed).toBe(false)
      expect(isWaiting(Option.some(state))).toBe(false)
      expect(arrivalOf(Option.some(state), note.key)).toEqual(Option.some(false))
    }),
  )

  it.effect(
    'does not draw words twice, or call them unsent, when their answer was lost and the runtime took them all the same',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        yield* made.send(note)
        yield* made.refuse(Option.none())
        const state = (yield* made.at('Idle')).state
        expect(unsentKeys(draw(state))).toEqual(['k1'])
        // The runtime had them after all: their message and its reply are in the conversation.
        const drawn = draw(state, [
          placed('entry-12', 'Draft the note', 'k1'),
          reply('run-13', 'Here it is'),
        ])
        expect(rows(drawn)).toEqual([
          [sentId(note), 'Draft the note'],
          ['run-13', 'Here it is'],
        ])
        expect(drawn.unsent).toEqual([])
        expect(drawn.owed).toBe(false)
        expect(drawn.seen.shown.map((proof) => proof.key)).toEqual(['k1'])
      }),
  )

  it.effect('sends words that did not arrive again as the same delivery', () =>
    Effect.gen(function* () {
      const made = yield* started()
      yield* made.send(note)
      yield* made.refuse(Option.none())
      yield* made.at('Idle')
      yield* made.again()
      yield* made.take(run('run-a', '7'))
      const state = (yield* made.at('Idle')).state
      expect(made.keys()).toEqual(['k1', 'k1'])
      const drawn = draw(state)
      expect(drawn.unsent).toEqual([])
      // One row, under the id it was first drawn under, through the failure and the retry.
      expect(rows(drawn)).toEqual([[sentId(note), 'Draft the note']])
      expect(arrivalOf(Option.some(state), note.key)).toEqual(Option.some(true))
    }),
  )

  it.effect('moves on from words that did not arrive when the Person says something else', () =>
    Effect.gen(function* () {
      const made = yield* started()
      yield* made.send(note)
      yield* made.refuse(Option.none())
      yield* made.at('Idle')
      const sent = yield* made.send(more)
      const drawn = draw(sent.after)
      expect(drawn.unsent).toEqual([])
      expect(rows(drawn)).toEqual([[sentId(more), 'And send it to Ada']])
      expect(made.keys()).toEqual(['k1', 'k2'])
    }),
  )

  it.effect(
    'takes words sent while others are on their way, and hands them over one at a time in the order written',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        yield* made.send(note)
        const second = yield* made.send(more)
        // Taken, not refused, and the call in flight was not started again.
        expect(second.handled).toBe(true)
        expect(made.asked).toEqual([note])
        expect(rows(draw(second.after))).toEqual([
          [sentId(note), 'Draft the note'],
          [sentId(more), 'And send it to Ada'],
        ])
        yield* made.take(run('run-a', '7'))
        yield* made.take(run('run-b', '8'))
        yield* made.at('Idle')
        expect(made.asked).toEqual([note, more])
      }),
  )

  it.effect(
    'keeps what waited behind a delivery that failed as not sent, says Vivid is not at work on it, and sends it all again in order',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        yield* made.send(note)
        yield* made.send(more)
        yield* made.refuse(Option.none())
        const state = (yield* made.at('Idle')).state
        // The second was never handed to the server, and nothing will hand it over by itself.
        expect(made.asked).toEqual([note])
        const drawn = draw(state)
        expect(unsentKeys(drawn)).toEqual(['k1', 'k2'])
        expect(drawn.owed).toBe(false)
        expect(isWaiting(Option.some(state))).toBe(false)
        expect(arrivalOf(Option.some(state), more.key)).toEqual(Option.some(false))
        expect(rows(drawn)).toEqual([
          [sentId(note), 'Draft the note'],
          [sentId(more), 'And send it to Ada'],
        ])
        // Sending again sends everything offered, in the order it was written, under its keys.
        yield* made.again()
        yield* made.take(run('run-a', '7'))
        yield* made.take(run('run-b', '8'))
        const after = (yield* made.at('Idle')).state
        expect(made.keys()).toEqual(['k1', 'k1', 'k2'])
        expect(draw(after).unsent).toEqual([])
      }),
  )

  it.effect(
    'hands nothing more to the server once the Person has stopped Vivid, and keeps it all as not sent',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        yield* made.send(note)
        yield* made.send(more)
        const halted = yield* made.stop
        expect(halted.handled).toBe(true)
        expect(SendingStates.matches(halted.after, 'Idle')).toBe(true)
        // The call that was with the server is called off, so its answer has nowhere to land.
        expect(yield* made.dropped).toBe('k1')
        // An answer handed over now is taken by no call: the one that would have had it was
        // called off, and nothing hands the second delivery over. (This shows the call was
        // called off and the queue not drained; it is not a late answer from a real server.)
        yield* made.take(run('run-a', '7'))
        const still = yield* made.probe.sendAndAwait(SendingEvents.Stop())
        expect(still.handled).toBe(true)
        expect(made.asked).toEqual([note])
        const drawn = draw(still.after)
        expect(unsentKeys(drawn)).toEqual(['k1', 'k2'])
        expect(drawn.owed).toBe(false)
        // The server had the first after all, and the conversation shows it: it is not offered
        // again, and what the Person is offered is only what is not there.
        const shown = draw(still.after, [placed('entry-12', 'Draft the note', 'k1')])
        expect(unsentKeys(shown)).toEqual(['k2'])
        expect(rows(shown)).toEqual([
          [sentId(note), 'Draft the note'],
          [sentId(more), 'And send it to Ada'],
        ])
        // Not shown, it is sent again under the key it had: the same delivery if it did land.
        yield* made.again()
        yield* made.take(run('run-b', '8'))
        yield* made.at('Idle')
        expect(made.keys()).toEqual(['k1', 'k1', 'k2'])
      }),
  )

  it.effect(
    'never takes a conversation that does not show a delivery as proof it did not land, nor gives it another key',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        const state = yield* made.taken(note, run('run-a', '7'))
        // The Thread's record says the Run was stopped; the conversation drawn is from before
        // the send (a link being opened again, a kept copy) and does not show the message.
        const stale = draw(state, [reply('run-3', 'Hello')], [run('run-a', '7', stopped)], {
          live: false,
        })
        // The server took it: it is not offered as unsent, and nothing would send it twice.
        expect(stale.unsent).toEqual([])
        expect(stale.owed).toBe(false)
        expect(rows(stale).at(-1)).toEqual([sentId(note), 'Draft the note'])
        const again = yield* made.again()
        expect(SendingStates.matches(again.after, 'Idle')).toBe(true)
        expect(made.keys()).toEqual(['k1'])
        // The conversation catches up and shows it: one row, the row it was.
        expect(rows(draw(state, [placed('entry-12', 'Draft the note', 'k1')]))).toEqual([
          [sentId(note), 'Draft the note'],
        ])
      }),
  )

  it.effect(
    'sends everything offered when one of them is sent again, whatever each was kept for',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        // The first is with the server when the Person stops; the second waits behind it.
        yield* made.send(note)
        yield* made.send(more)
        yield* made.stop
        yield* made.dropped
        const drawn = draw((yield* made.at('Idle')).state)
        expect(unsentKeys(drawn)).toEqual(['k1', 'k2'])
        // Whichever row's "send again" is pressed, nothing offered is left behind or let go.
        yield* made.again()
        yield* made.take(run('run-a', '7'))
        yield* made.take(run('run-b', '8'))
        const state = (yield* made.at('Idle')).state
        expect(made.keys()).toEqual(['k1', 'k1', 'k2'])
        expect(draw(state).unsent).toEqual([])
        expect(rows(draw(state))).toEqual([
          [sentId(note), 'Draft the note'],
          [sentId(more), 'And send it to Ada'],
        ])
      }),
  )

  it.effect('keeps an accepted delivery when only a newer Run is listed', () =>
    Effect.gen(function* () {
      const made = yield* started()
      const state = yield* made.taken(note, run('run-a', '7'))
      const drawn = draw(state, [], [run('run-b', '8')])
      expect(rows(drawn)).toEqual([[sentId(note), 'Draft the note']])
      expect(drawn.seen.ended).toEqual([])
      const next = yield* made.again(drawn.seen)
      expect(JSON.stringify(next.after)).toContain('Draft the note')
      expect(made.keys()).toEqual(['k1'])
    }),
  )

  it.effect('releases words and pictures of an accepted unplaced delivery when its Run ends', () =>
    Effect.gen(function* () {
      const made = yield* started()
      const pictured: Delivery = {
        thread,
        key: 'withdrawn',
        words: 'Words never placed',
        pictures: [
          { type: 'image', mimeType: 'image/png', data: 'unplaced-base64', filename: 'lost.png' },
        ],
      }
      const state = yield* made.taken(pictured, run('run-a', '7'))
      const drawn = draw(state, [reply('answer', 'Earlier answer')], [run('run-a', '7', stopped)])
      expect(rows(drawn)).toEqual([['answer', 'Earlier answer']])
      expect(drawn.unsent).toEqual([])
      expect(drawn.owed).toBe(false)
      const next = yield* made.send(more, drawn.seen)
      expect(JSON.stringify(next.after)).not.toContain('Words never placed')
      expect(JSON.stringify(next.after)).not.toContain('unplaced-base64')
      yield* made.take(run('run-b', '8'))
      yield* made.at('Idle')
      yield* made.again(drawn.seen)
      expect(made.keys()).toEqual(['withdrawn', 'k2'])
    }),
  )

  it.effect('accepts a terminal receiptless Run without offering another delivery', () =>
    Effect.gen(function* () {
      const made = yield* started()
      const { submissionId: _submission, ...terminal } = run('run-a', '7', stopped)
      const state = yield* made.taken(note, terminal)
      const drawn = draw(state)
      expect(rows(drawn)).toEqual([])
      expect(drawn.unsent).toEqual([])
      expect(drawn.owed).toBe(false)
      yield* made.again(drawn.seen)
      expect(made.keys()).toEqual(['k1'])
    }),
  )

  it.effect(
    'draws only its own deliveries under their keys: another’s message keeps the id the conversation gave it',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        const state = yield* made.taken(note, run('run-a', '7'))
        // A shared Thread: someone else's message was sent under a key of their own, and another
        // under the very key this client used (a key is one Person's, not everyone's).
        const theirs = placed('entry-9', 'From Dami', 'dami-key')
        const mine = placed('entry-12', 'Draft the note', 'k1')
        const clash = placed('entry-15', 'Something else', 'k1')
        const drawn = draw(state, [theirs, mine, clash])
        expect(rows(drawn)).toEqual([
          ['entry-9', 'From Dami'],
          [sentId(note), 'Draft the note'],
          // One delivery is one message: a second under the same key is not this client's.
          ['entry-15', 'Something else'],
        ])
        // No two rows share an id.
        expect(new Set(drawn.said.map((message) => message.id)).size).toBe(3)
        // Once the conversation shows it the words and pictures are let go, and the row stays
        // the row it was for as long as this client remembers the key is its own.
        const next = yield* made.send(more, drawn.seen)
        expect(JSON.stringify(next.after)).not.toContain('Draft the note')
        expect(rows(draw(next.after, [theirs, mine])).slice(0, 2)).toEqual([
          ['entry-9', 'From Dami'],
          [sentId(note), 'Draft the note'],
        ])
        // A client that holds nothing (after a reload) draws every message under its own id.
        const fresh = yield* started()
        const idle = (yield* fresh.at('Idle')).state
        expect(rows(draw(idle, [theirs, mine]))).toEqual([
          ['entry-9', 'From Dami'],
          ['entry-12', 'Draft the note'],
        ])
      }),
  )

  it.effect('recognises a keyless older echo by the admitted submission', () =>
    Effect.gen(function* () {
      const made = yield* started()
      const state = yield* made.taken(note, run('run-a', '7'))
      const echo: ConversationMessage = {
        id: 'entry-12',
        role: 'user',
        purpose: 'user',
        display: 'visible',
        submissionId: '7',
        parts: [{ type: 'text', text: 'Draft the note', state: 'done' }],
      }
      const drawn = draw(state, [echo], [run('run-a', '7', stopped)])
      expect(rows(drawn)).toEqual([[sentId(note), 'Draft the note']])
      expect(drawn.unsent).toEqual([])
      yield* made.again(drawn.seen)
      expect(made.keys()).toEqual(['k1'])
    }),
  )

  it.effect(
    'uses a receipt published later by the admitted Run and preserves keyed late placement',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        const { submissionId: _submission, ...unrecorded } = run('run-a', '7')
        const state = yield* made.taken(note, unrecorded)
        const old = drawing({
          messages: [],
          live: true,
          sending: Option.some(state),
          runs: [run('run-a', '7', stopped)],
          ahead: false,
        })
        expect(old.unsent).toEqual([])
        expect(old.owed).toBe(false)
        const echo: ConversationMessage = {
          id: 'entry-7',
          role: 'user',
          purpose: 'user',
          display: 'visible',
          key: 'k1',
          submissionId: '7',
          parts: [{ type: 'text', text: 'Draft the note', state: 'done' }],
        }
        const arrived = drawing({
          messages: [echo],
          live: true,
          sending: Option.some(state),
          runs: [run('run-a', '7', stopped)],
          ahead: false,
        })
        expect(rows(arrived)).toEqual([[sentId(note), 'Draft the note']])
        expect(arrived.unsent).toEqual([])
        yield* made.again(arrived.seen)
        expect(made.keys()).toEqual(['k1'])
      }),
  )

  it.effect('keeps accepted placement uncertain through a terminal Run and an old live frame', () =>
    Effect.gen(function* () {
      const made = yield* started()
      const state = yield* made.taken(note, run('run-a', '7'))
      const ended = draw(state, [], [run('run-a', '7', stopped)])
      expect(ended.unsent).toEqual([])
      expect(ended.owed).toBe(false)
      yield* made.again(ended.seen)
      expect(made.keys()).toEqual(['k1'])
      const still = (yield* made.at('Idle')).state
      expect(
        rows(
          draw(still, [
            {
              id: 'entry-12',
              role: 'user',
              purpose: 'user',
              display: 'visible',
              submissionId: '7',
              parts: [{ type: 'text', text: 'Draft the note', state: 'done' }],
            },
          ]),
        ),
      ).toEqual([[sentId(note), 'Draft the note']])
    }),
  )

  it.effect('does not let an earlier shared key collision swallow a failed local send', () =>
    Effect.gen(function* () {
      const made = yield* started()
      yield* made.send(note)
      yield* made.refuse(Option.none())
      const state = (yield* made.at('Idle')).state
      const clash: ConversationMessage = {
        id: 'entry-6',
        role: 'user',
        purpose: 'user',
        display: 'visible',
        key: 'k1',
        submissionId: '6',
        parts: [{ type: 'text', text: 'From Dami', state: 'done' }],
      }
      const drawn = drawing({
        messages: [clash],
        live: true,
        sending: Option.some(state),
        runs: [],
        ahead: false,
      })
      expect(rows(drawn)).toEqual([['entry-6', 'From Dami']])
      expect(unsentKeys(drawn)).toEqual(['k1'])
      yield* made.again(drawn.seen)
      yield* made.take(run('run-a', '7'))
      const after = (yield* made.at('Idle')).state
      const echo: ConversationMessage = {
        id: 'entry-7',
        role: 'user',
        purpose: 'user',
        display: 'visible',
        key: 'k1',
        submissionId: '7',
        parts: [{ type: 'text', text: 'Draft the note', state: 'done' }],
      }
      const shown = drawing({
        messages: [clash, echo],
        live: true,
        sending: Option.some(after),
        runs: [],
        ahead: false,
      })
      expect(rows(shown)).toEqual([
        ['entry-6', 'From Dami'],
        [sentId(note), 'Draft the note'],
      ])
      yield* made.send(more, shown.seen)
      yield* made.take(run('run-b', '8'))
      const released = (yield* made.at('Idle')).state
      expect(
        rows(
          drawing({
            messages: [clash, echo],
            live: true,
            sending: Option.some(released),
            runs: [],
            ahead: false,
          }),
        ).slice(0, 2),
      ).toEqual([
        ['entry-6', 'From Dami'],
        [sentId(note), 'Draft the note'],
      ])
      expect(made.keys()).toEqual(['k1', 'k1', 'k2'])
    }),
  )

  it.effect('preserves a complete creation queue through failure, further words and Stop', () =>
    Effect.gen(function* () {
      const made = yield* started()
      yield* made.begin()
      expect(yield* made.creation).toEqual({ id: thread, title: 'Draft the note', projectId: null })
      const queued = yield* made.send(more)
      expect(rows(draw(queued.after))).toEqual([
        [sentId(note), 'Draft the note'],
        [sentId(more), 'And send it to Ada'],
      ])
      expect(made.asked).toEqual([])
      yield* made.creationFailed
      const failed = (yield* made.at('Uncreated')).state
      expect(unsentKeys(draw(failed))).toEqual(['k1', 'k2'])
      const last = delivery('k3', 'Then archive it')
      const withLast = yield* made.send(last)
      expect(unsentKeys(draw(withLast.after))).toEqual(['k1', 'k2', 'k3'])
      yield* made.again()
      expect(yield* made.creation).toEqual({ id: thread, title: 'Draft the note', projectId: null })
      yield* made.stop
      expect(yield* made.abandoned).toBe(thread)
      yield* made.created
      const held = yield* made.probe.sendAndAwait(SendingEvents.Stop())
      expect(unsentKeys(draw(held.after))).toEqual(['k1', 'k2', 'k3'])
      expect(made.asked).toEqual([])
      yield* made.again()
      expect(yield* made.creation).toEqual({ id: thread, title: 'Draft the note', projectId: null })
      yield* made.take(run('run-a', '7'))
      yield* made.take(run('run-b', '8'))
      yield* made.take(run('run-c', '9'))
      const after = (yield* made.at('Idle')).state
      expect(made.asked).toEqual([note, more, last])
      expect(draw(after).unsent).toEqual([])
    }),
  )

  it.effect('plans a send from rest, a second one behind it, and a stop', () =>
    Effect.gen(function* () {
      // A plan only: it runs no call to the server, so nothing here is taken or refused.
      const trace = yield* MachineTest.run(Sending, {
        events: [
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- A scenario takes decoded events; the constructor's value is opaque until the machine decodes it (`@typeonce/effect-machine` 0.40.0 `EventConstruction`).
          { _tag: 'Send', delivery: note, seen: NOTHING_SEEN },
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- As above.
          { _tag: 'Send', delivery: more, seen: NOTHING_SEEN },
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- As above.
          { _tag: 'Stop' },
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- As above.
          { _tag: 'Again', seen: NOTHING_SEEN },
        ],
      })
      yield* MachineTest.verify(Sending, trace)
    }),
  )
})

describe('a Thread’s machine in an app’s registry', () => {
  it.effect(
    'keeps creation and queued payloads when the last screen departs with no idle grace',
    () =>
      Effect.gen(function* () {
        const creations = yield* Queue.unbounded<CreateThreadRequest>()
        const created = yield* Queue.unbounded<void>()
        const deliveries = yield* Queue.unbounded<Delivery>()
        const replies = yield* Queue.unbounded<Run>()
        const dropped = yield* Queue.unbounded<string>()
        const machines = makeSending(
          Layer.succeed(Delivering, {
            create: (request) =>
              Effect.andThen(Queue.offer(creations, request), Queue.take(created)),
            send: (message) =>
              Effect.andThen(Queue.offer(deliveries, message), Queue.take(replies)).pipe(
                Effect.onInterrupt(() => Queue.offer(dropped, message.key)),
              ),
          }),
        )
        const registry = AtomRegistry.make()
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()))
        const machine = machines(thread)
        beginInRegistry(registry, machine, {
          creation: { id: thread, title: 'Draft the note', projectId: null },
          delivery: note,
        })
        expect(yield* Queue.take(creations)).toEqual({
          id: thread,
          title: 'Draft the note',
          projectId: null,
        })
        const reference = registry.get(machine.ref)
        if (!AsyncResult.isSuccess(reference))
          throw new Error('The creation handshake requires an active machine')
        const probe = yield* MachineTest.probe(Sending, reference.value)
        yield* probe.sendAndAwait(SendingEvents.Send({ delivery: more, seen: NOTHING_SEEN }))
        const depart = registry.mount(stateOf(machine))
        depart()
        yield* Queue.offer(created, undefined)
        expect(yield* Queue.take(deliveries)).toEqual(note)
        yield* Queue.offer(replies, run('run-a', '7'))
        expect(yield* Queue.take(deliveries)).toEqual(more)
        yield* Queue.offer(replies, run('run-b', '8'))
        const idle = yield* Machine.waitFor(reference.value, (at) =>
          SendingStates.matches(at.state, 'Idle'),
        )
        expect(rows(draw(idle.state))).toEqual([
          [sentId(note), 'Draft the note'],
          [sentId(more), 'And send it to Ada'],
        ])
        const last = delivery('k3', 'Archive it')
        yield* probe.sendAndAwait(SendingEvents.Send({ delivery: last, seen: NOTHING_SEEN }))
        expect(yield* Queue.take(deliveries)).toEqual(last)
        machines.forget(registry)
        expect(yield* Queue.take(dropped)).toBe('k3')
      }),
  )

  it.effect(
    'takes words said to a machine nothing has read yet, and gives each Thread its own',
    () =>
      Effect.gen(function* () {
        const asked = yield* Queue.unbounded<Delivery>()
        const machines = makeSending(
          Layer.succeed(Delivering, {
            create: () => Effect.never,
            send: (made) => Effect.andThen(Queue.offer(asked, made), Effect.never),
          }),
        )
        // Kept for a while after its last reader, as an app's registry keeps everything
        // (`makeLive`): that is what lets a delivery finish when nothing is reading its machine.
        const registry = AtomRegistry.make({ defaultIdleTTL: 60_000 })
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()))
        const machine = machines(thread)
        // Nothing has read the machine yet. Whether it has started by the time it is spoken to
        // is the registry's business; either way the words are handed over, never dropped.
        send(registry, machine, { delivery: note, seen: NOTHING_SEEN })
        expect(yield* Queue.take(asked)).toEqual(note)
        expect(isWaiting(registry.get(stateOf(machine)))).toBe(true)
        // The same Thread is the same machine at every asking; another Thread's knows nothing of it.
        expect(machines(thread)).toBe(machine)
        const other = machines(ThreadId.make('t2'))
        expect(other).not.toBe(machine)
        registry.mount(stateOf(other))
        expect(isWaiting(registry.get(stateOf(other)))).toBe(false)
      }),
  )
})

describe('whether Vivid is at work', () => {
  const quiet: Parameters<typeof isWorking>[0] = {
    owed: false,
    conversation: Option.some(conversation(false)),
    attention: Option.some('Quiet'),
  }

  it('is so while the conversation says a reply is being written, or the Thread’s record does', () => {
    expect(isWorking(quiet)).toBe(false)
    expect(isWorking({ ...quiet, conversation: Option.some(conversation(true)) })).toBe(true)
    expect(isWorking({ ...quiet, attention: Option.some('Working') })).toBe(true)
    expect(isWorking({ ...quiet, owed: true })).toBe(true)
    // Before either has been read, nothing says so.
    expect(isWorking({ ...quiet, conversation: Option.none(), attention: Option.none() })).toBe(
      false,
    )
  })

  it.effect(
    'is owed from the send until the conversation has the delivery’s message or its Run has ended',
    () =>
      Effect.gen(function* () {
        const made = yield* started()
        const state = yield* made.taken(note, run('run-a', '7'))
        // The server has it and the conversation does not show it yet: Vivid is about to answer.
        expect(draw(state).owed).toBe(true)
        expect(draw(state, [], [run('run-a', '7')]).owed).toBe(true)
        // Once its message is there, the conversation's own word is what counts.
        expect(draw(state, [placed('entry-12', 'Draft the note', 'k1')]).owed).toBe(false)
        // Stopped before the runtime placed it: no message will come, and its Run says so.
        expect(draw(state, [], [run('run-a', '7', stopped)]).owed).toBe(false)
        // Not listed yet: the Thread's record is older than the send.
        expect(draw(state, [], [run('run-old', '3')]).owed).toBe(true)
        // Not listed any more: Runs that began after it are, and it is not among them.
        expect(draw(state, [], [run('run-new', '300')]).owed).toBe(false)
      }),
  )
})
