import { describe, expect, it } from '@effect/vitest'
import { Wire, type PairingTransport } from '@vivid/state'
import { Effect, Option, Redacted, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  adopting,
  AdoptionRefused,
  AdoptionUnfinished,
  BrowserUnopened,
  Handing,
  handOff,
  Way,
  wayIn,
  type Handoff,
} from './pairing'

/** The body Better Auth's `/device/code` answers with. */
const issued = Wire.Answered({
  ok: true,
  body: JSON.stringify({
    device_code: 'device-secret',
    user_code: 'ABCD2345',
    expires_in: 600,
    interval: 5,
  }),
})

const pending = Wire.Answered({
  ok: false,
  body: JSON.stringify({ error: 'authorization_pending' }),
})
const denied = Wire.Answered({ ok: false, body: JSON.stringify({ error: 'access_denied' }) })
const granted = Wire.Answered({
  ok: true,
  body: JSON.stringify({ access_token: 'session-token', token_type: 'Bearer', expires_in: 3600 }),
})

/** One line for a state, so a test reads as the order things happened in. */
const said = (state: Handing) =>
  Handing.$match(state, {
    Asking: () => 'show Asking',
    Waiting: ({ userCode, browser }) => `show Waiting ${userCode} ${browser}`,
    Adopting: () => 'show Adopting',
    Unfinished: ({ token }) => `show Unfinished ${Redacted.value(token)}`,
    Ended: ({ why }) => `show Ended ${why}`,
  })

/** What a test decides about the world outside the hand-off. */
interface World {
  readonly answers: ReadonlyArray<Wire>
  readonly open: Effect.Effect<void, BrowserUnopened>
  readonly trade: Effect.Effect<void, AdoptionRefused | AdoptionUnfinished>
}

/**
 * Runs one hand-off against a server that answers the token request with `answers` in order
 * ("pending" once they run out), a browser that opens as `open` says and a cookie trade that ends
 * as `trade` says. Everything the hand-off did outside itself is recorded in order, and the
 * hand-off's parts are handed back so a test can run the retry the card offers.
 */
const run = Effect.fn('Test.handOff')(function* (world: World) {
  const did = yield* Ref.make<ReadonlyArray<string>>([])
  const note = (what: string) => Ref.update(did, (all) => [...all, what])
  const asked = yield* Ref.make(0)
  const transport: PairingTransport = {
    requestCode: Effect.succeed(issued),
    askToken: () =>
      Ref.modify(asked, (count) => {
        const answer = world.answers[count]
        return [answer === undefined ? pending : answer, count + 1]
      }),
  }
  const way: Handoff = {
    transport,
    open: (userCode) => Effect.andThen(note(`open ${userCode}`), world.open),
    adopt: (token) => Effect.andThen(note(`adopt ${Redacted.value(token)}`), world.trade),
    show: (state) => note(said(state)),
    arrive: note('arrive'),
  }
  yield* handOff(way).pipe(Effect.forkScoped)
  yield* TestClock.adjust(0)
  return { did: Ref.get(did), way }
})

const waiting = ['show Asking', 'show Waiting ABCD2345 opening', 'open ABCD2345']
const opened = [...waiting, 'show Waiting ABCD2345 opened']
const approved = [...opened, 'show Adopting', 'adopt session-token']

describe('signing the desktop window in through the browser', () => {
  it.effect('opens the browser once with the code, and waits', () =>
    Effect.gen(function* () {
      const { did } = yield* run({ answers: [], open: Effect.void, trade: Effect.void })
      expect(yield* did).toEqual(opened)
      // Asking again does not open the browser again.
      yield* TestClock.adjust('30 seconds')
      expect(yield* did).toEqual(opened)
    }),
  )

  it.effect('says the browser did not open, and goes on waiting on the same code', () =>
    Effect.gen(function* () {
      const { did } = yield* run({
        answers: [pending, granted],
        open: Effect.fail(new BrowserUnopened({})),
        trade: Effect.void,
      })
      expect(yield* did).toEqual([...waiting, 'show Waiting ABCD2345 unopened'])
      // The code is still good: approved from a browser opened another way, it signs in.
      yield* TestClock.adjust('10 seconds')
      expect(yield* did).toEqual([
        ...waiting,
        'show Waiting ABCD2345 unopened',
        'show Adopting',
        'adopt session-token',
        'arrive',
      ])
    }),
  )

  it.effect('trades the granted token for a cookie before it arrives', () =>
    Effect.gen(function* () {
      const { did } = yield* run({
        answers: [pending, granted],
        open: Effect.void,
        trade: Effect.void,
      })
      yield* TestClock.adjust('10 seconds')
      expect(yield* did).toEqual([...approved, 'arrive'])
    }),
  )

  it.effect('ends when the server says no to the trade, and does not arrive', () =>
    Effect.gen(function* () {
      const { did } = yield* run({
        answers: [granted],
        open: Effect.void,
        trade: Effect.fail(new AdoptionRefused({})),
      })
      yield* TestClock.adjust('5 seconds')
      expect(yield* did).toEqual([...approved, 'show Ended refused'])
    }),
  )

  it.effect('keeps the token for another try when the trade got no answer', () =>
    Effect.gen(function* () {
      const { did } = yield* run({
        answers: [granted],
        open: Effect.void,
        trade: Effect.fail(new AdoptionUnfinished({})),
      })
      yield* TestClock.adjust('5 seconds')
      expect(yield* did).toEqual([...approved, 'show Unfinished session-token'])
    }),
  )

  it.effect('stops waiting on a trade that stalls, after fifteen seconds', () =>
    Effect.gen(function* () {
      const { did } = yield* run({ answers: [granted], open: Effect.void, trade: Effect.never })
      yield* TestClock.adjust('5 seconds')
      expect(yield* did).toEqual(approved)
      yield* TestClock.adjust('14 seconds')
      expect(yield* did).toEqual(approved)
      yield* TestClock.adjust('1 second')
      expect(yield* did).toEqual([...approved, 'show Unfinished session-token'])
    }),
  )

  it.effect('arrives when the trade is tried again with the token it kept', () =>
    Effect.gen(function* () {
      const { did, way } = yield* run({
        answers: [granted],
        open: Effect.void,
        trade: Effect.fail(new AdoptionUnfinished({})),
      })
      yield* TestClock.adjust('5 seconds')
      // What "Try again" on the card runs, once the server can be reached.
      yield* adopting({ ...way, adopt: () => Effect.void }, Redacted.make('session-token'))
      expect(yield* did).toEqual([
        ...approved,
        'show Unfinished session-token',
        'show Adopting',
        'arrive',
      ])
    }),
  )

  it.effect('ends without asking for a cookie when the browser said no', () =>
    Effect.gen(function* () {
      const { did } = yield* run({ answers: [denied], open: Effect.void, trade: Effect.void })
      yield* TestClock.adjust('5 seconds')
      expect(yield* did).toEqual([...opened, 'show Ended denied'])
    }),
  )
})

describe('which way a window signs in with Google', () => {
  const openApproval = () => Promise.resolve()

  it('is a redirect in a browser tab, where there is no desktop bridge', () => {
    expect(wayIn(Option.none())).toEqual(Way.Browser())
  })

  it('is the hand-off in a desktop app whose bridge can open the approval page', () => {
    expect(wayIn(Option.some({ openApproval }))).toEqual(Way.Shell({ openApproval }))
  })

  it('is not offered in a desktop app installed before the bridge could', () => {
    expect(wayIn(Option.some({}))).toEqual(Way.Outdated())
    // A bridge read off the window is whatever that shell put there, whatever its type says.
    expect(wayIn(Option.some({ openApproval: 'not a function' }))).toEqual(Way.Outdated())
    expect(wayIn(Option.some('not a bridge'))).toEqual(Way.Outdated())
  })
})
