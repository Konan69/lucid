import { describe, expect, it } from '@effect/vitest'
import { CreateThreadRequest, PersonId, ThreadAudience, ThreadResponse } from '@vivid/contracts'
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

const { FirstWords, firstWords, startThread } = await import('./threads')

/** Waits until a Thread's first words stand as `tag`, on the store's own signal and no clock. */
const stands = (id: ReturnType<typeof startThread>, tag: 'Unsent' | 'Settled') =>
  Effect.callback<void>((resume) => {
    const there = () => FirstWords.$is(tag)(firstWords.of(id))
    if (there()) {
      resume(Effect.void)
      return Effect.void
    }
    const stop = firstWords.subscribe(() => {
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

      yield* stands(startThread('Draft the invoice for Dami'), 'Settled')

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
      yield* stands(id, 'Settled')

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

      yield* stands(startThread('Good morning'), 'Settled')
      yield* stands(startThread('Good morning'), 'Settled')

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
      yield* stands(id, 'Settled')

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
      yield* stands(id, 'Settled')

      expect(browser.server.asked('CreateThread').slice(from)).toEqual([
        { id, title: 'Draft the invoice for Dami', projectId: null },
      ])
    }),
  )
})
