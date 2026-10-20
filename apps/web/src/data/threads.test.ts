import { describe, expect, it } from '@effect/vitest'
import {
  CreateThreadRequest,
  PersonId,
  ThreadAudience,
  ThreadId,
  ThreadResponse,
} from '@vivid/contracts'
import { Effect, Schema } from 'effect'
import { open, wire } from '../test/browser'

/**
 * A new Thread's first words, followed to the one place they leave the browser: the message the
 * conversation client posts. The server admits a message under the key it is posted with and
 * makes a key of its own when there is none (`apps/server/src/threads/gateway.ts`), so a first
 * message posted twice without a key is two Messages and two Runs.
 *
 * Everything between `startThread` and the network is the app's own: the live engine, its RPC
 * client and Flue's conversation client. Only the browser is the test's (`test/browser.ts`).
 */

const browser = open()

const readCreate = Schema.decodeUnknownSync(CreateThreadRequest)
// The server makes every Thread it is asked for, as the Person's own.
browser.server.answers('CreateThread', (payload) => {
  const { id, title, projectId } = readCreate(payload)
  return wire(ThreadResponse, {
    thread: {
      id,
      title,
      preview: '',
      updatedAt: 0,
      archived: false,
      createdBy: { id: PersonId.make('ada'), name: 'Ada', image: null },
      audience: ThreadAudience.cases.Private.make({}),
      projectId,
      attention: 'Quiet',
    },
  })
})

const { FirstWords, firstWords, saidWith, startThread, useFirstWords, wordsFor } =
  await import('./threads')

/** Waits until a Thread's first words stand as `tag`, on the store's own signal and no clock. */
const stands = (id: ReturnType<typeof startThread>, tag: 'Unsent' | 'Said') =>
  Effect.callback<void>((resume) => {
    const there = () => FirstWords.$is(tag)(wordsFor(id)(useFirstWords.getState()))
    if (there()) {
      resume(Effect.void)
      return Effect.void
    }
    const stop = useFirstWords.subscribe(() => {
      if (!there()) return
      stop()
      resume(Effect.void)
    })
    return Effect.sync(stop)
  })

/** What has been posted since `from`, which is how many posts a case started after. */
const postedSince = (from: number) => browser.network.posts().slice(from)

/** A delivery's key: the random word `startThread` makes for it. */
const KEY = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u

describe('a new Thread’s first words', () => {
  it.live('leave under a key that names the delivery', () =>
    Effect.gen(function* () {
      const from = browser.network.posts().length
      browser.network.arrives = true

      yield* stands(startThread('Draft the invoice for Dami'), 'Said')

      expect(postedSince(from)).toEqual([
        {
          kind: 'user',
          body: 'Draft the invoice for Dami',
          idempotencyKey: expect.stringMatching(KEY),
        },
      ])
    }),
  )

  it.live('go again as the same delivery when their answer was lost', () =>
    Effect.gen(function* () {
      const from = browser.network.posts().length
      browser.network.arrives = false
      const id = startThread('Draft the invoice for Dami')
      yield* stands(id, 'Unsent')

      browser.network.arrives = true
      firstWords.again(id)
      yield* stands(id, 'Said')

      const [first, second] = postedSince(from)
      expect(first).toEqual({
        kind: 'user',
        body: 'Draft the invoice for Dami',
        idempotencyKey: expect.stringMatching(KEY),
      })
      // The same key is the same delivery to the server: it answers with the Run it already made.
      expect(second).toEqual(first)
      expect(postedSince(from)).toHaveLength(2)
    }),
  )

  it.live('are a delivery of their own in each Thread, the same words or not', () =>
    Effect.gen(function* () {
      const from = browser.network.posts().length
      browser.network.arrives = true

      yield* stands(startThread('Good morning'), 'Said')
      yield* stands(startThread('Good morning'), 'Said')

      const [one, other] = postedSince(from)
      expect(one).toEqual({
        kind: 'user',
        body: 'Good morning',
        idempotencyKey: expect.stringMatching(KEY),
      })
      expect(other).toEqual({
        kind: 'user',
        body: 'Good morning',
        idempotencyKey: expect.stringMatching(KEY),
      })
      expect(other).not.toEqual(one)
    }),
  )

  it.live('are posted once when "Send again" is pressed twice in one turn', () =>
    Effect.gen(function* () {
      const from = browser.network.posts().length
      browser.network.arrives = false
      const id = startThread('Draft the invoice for Dami')
      yield* stands(id, 'Unsent')

      browser.network.arrives = true
      firstWords.again(id)
      firstWords.again(id)
      yield* stands(id, 'Said')

      // The post whose answer was lost, and one more.
      expect(postedSince(from)).toHaveLength(2)
    }),
  )

  it.live('ask the server for their Thread once, however often they are sent', () =>
    Effect.gen(function* () {
      const from = browser.server.asked('CreateThread').length
      browser.network.arrives = false
      const id = startThread('Draft the invoice for Dami')
      yield* stands(id, 'Unsent')

      browser.network.arrives = true
      firstWords.again(id)
      yield* stands(id, 'Said')

      expect(browser.server.asked('CreateThread').slice(from)).toEqual([
        { id, title: 'Draft the invoice for Dami', projectId: null },
      ])
    }),
  )
})

describe('a new Thread’s conversation as it is drawn', () => {
  const id = ThreadId.make('6f0d3c7e-2a55-4d0b-9c61-0d6f3a1b2c4e')
  const said = FirstWords.Said({ words: 'Book the flight' })
  const message = (key: string, role: 'user' | 'assistant', text: string) => ({
    id: key,
    role,
    purpose: role,
    display: 'visible' as const,
    parts: [{ type: 'text' as const, text, state: 'done' as const }],
  })
  const ids = (messages: ReadonlyArray<{ readonly id: string }>) => messages.map((m) => m.id)

  it('keeps the words when a read after landing does not have them yet', () => {
    expect(ids(saidWith(id, said, [], true))).toEqual([`first:${id}`])
    expect(ids(saidWith(id, said, [message('s-1', 'assistant', 'On it')], true))).toEqual([
      `first:${id}`,
      's-1',
    ])
  })

  it('a follow-up sent before the history has the first words does not take their row', () => {
    const followUp = message('local-follow-up', 'user', 'And a hotel')
    expect(ids(saidWith(id, said, [followUp], true))).toEqual([`first:${id}`, followUp.id])
  })

  it('gives the conversation’s own copy of the words their row when it arrives', () => {
    const read = [message('s-1', 'user', 'Book the flight'), message('s-2', 'assistant', 'On it')]
    expect(ids(saidWith(id, said, read, true))).toEqual([`first:${id}`, 's-2'])
  })

  it('draws the words while they travel, even when Flue calls the history ready', () => {
    const sending = FirstWords.Sending({ words: 'Book the flight', projectId: null, key: 'k' })
    expect(ids(saidWith(id, sending, [], true))).toEqual([`first:${id}`])
  })

  it('leaves a Thread not started here as it is', () => {
    const read = [message('s-1', 'user', 'Hello')]
    expect(saidWith(id, FirstWords.Settled(), read, true)).toBe(read)
  })
})
