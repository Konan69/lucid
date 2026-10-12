import { describe, expect, it } from '@effect/vitest'
import type { SignedIn } from '@vivid/contracts/signin'
import { SignInEnding } from '@vivid/desktop/bridge'
import { Effect, Option, Redacted, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  browserSaid,
  endingSaid,
  Handing,
  handOff,
  landing,
  reopened,
  reopening,
  ShellUnreadable,
  TradeRefused,
  TradeUnanswered,
  Way,
  wayIn,
  type Handoff,
  type Shown,
} from './signin'

/** Values in the forms the contract asks for: 32 and 16 letters and digits, and 43 of base64url. */
const CODE = 'c'.repeat(32)
const STATE = 's'.repeat(16)
const VERIFIER = 'v'.repeat(43)

/** How the shell says a sign-in ended with a code, as it crosses the bridge: plain text. */
const handed = { code: CODE, state: STATE, verifier: VERIFIER }
const granted = SignInEnding.cases.Granted.make(handed)

/** One line for a state, so a test reads as the order things happened in. */
const said = (state: Handing) =>
  Handing.$match(state, {
    Opening: () => 'show Opening',
    Waiting: ({ browser }) => `show Waiting ${browser}`,
    Finishing: () => 'show Finishing',
    Ended: ({ why }) => `show Ended ${why}`,
  })

/** What a test decides about the world outside the hand-off. */
interface World {
  readonly begin: Handoff['begin']
  readonly ended: Handoff['ended']
  readonly trade: Effect.Effect<SignedIn, TradeRefused | TradeUnanswered>
}

/**
 * Runs one hand-off against a shell that answers `begin` and `ended` as the world says and a
 * server that answers the trade as it says. Everything the hand-off did outside itself is
 * recorded in order, the secret included, which only a test may write down.
 */
const run = Effect.fn('Test.handOff')(function* (world: World) {
  const did = yield* Ref.make<ReadonlyArray<string>>([])
  const note = (what: string) => Ref.update(did, (all) => [...all, what])
  const way: Handoff = {
    begin: Effect.andThen(note('begin'), world.begin),
    ended: world.ended,
    trade: ({ code, state, verifier }) =>
      Effect.andThen(note(`trade ${code} ${state} ${Redacted.value(verifier)}`), world.trade),
    show: (state) => note(said(state)),
    leave: note('leave'),
    arrive: (arrival) => note(`arrive ${arrival}`),
  }
  yield* handOff(way).pipe(Effect.forkScoped)
  yield* TestClock.adjust(0)
  return did
})

const opened = ['show Opening', 'begin', 'show Waiting opened']
const traded = [...opened, 'show Finishing', `trade ${CODE} ${STATE} ${VERIFIER}`]

describe('signing the desktop window in with Google', () => {
  it.effect('waits on the browser once the shell has opened it', () =>
    Effect.gen(function* () {
      const did = yield* run({
        begin: Effect.succeed('opened'),
        ended: Effect.never,
        trade: Effect.succeed({ arrival: 'returning' }),
      })
      expect(yield* Ref.get(did)).toEqual(opened)
    }),
  )

  it.effect('says the browser did not open, and still signs in when the code comes', () =>
    Effect.gen(function* () {
      const did = yield* run({
        begin: Effect.succeed('unopened'),
        ended: Effect.succeed(granted),
        trade: Effect.succeed({ arrival: 'returning' }),
      })
      expect(yield* Ref.get(did)).toEqual([
        'show Opening',
        'begin',
        'show Waiting unopened',
        'show Finishing',
        `trade ${CODE} ${STATE} ${VERIFIER}`,
        'arrive returning',
      ])
    }),
  )

  it.effect('trades the code and arrives as the server says: here before, or just made', () =>
    Effect.gen(function* () {
      for (const arrival of ['returning', 'first'] as const) {
        const did = yield* run({
          begin: Effect.succeed('opened'),
          ended: Effect.succeed(granted),
          trade: Effect.succeed({ arrival }),
        })
        expect(yield* Ref.get(did)).toEqual([...traded, `arrive ${arrival}`])
      }
    }),
  )

  it.effect('ends without a trade when the browser came back with no code, or not in time', () =>
    Effect.gen(function* () {
      for (const [ending, why] of [
        [SignInEnding.cases.Failed.make({}), 'failed'],
        [SignInEnding.cases.Expired.make({}), 'expired'],
      ] as const) {
        const did = yield* run({
          begin: Effect.succeed('opened'),
          ended: Effect.succeed(ending),
          trade: Effect.succeed({ arrival: 'returning' }),
        })
        expect(yield* Ref.get(did)).toEqual([...opened, `show Ended ${why}`])
      }
    }),
  )

  it.effect('does not arrive when the server says no to the trade, or does not answer it', () =>
    Effect.gen(function* () {
      for (const [failure, why] of [
        [new TradeRefused({}), 'refused'],
        [new TradeUnanswered({}), 'unreachable'],
      ] as const) {
        const did = yield* run({
          begin: Effect.succeed('opened'),
          ended: Effect.succeed(granted),
          trade: Effect.fail(failure),
        })
        expect(yield* Ref.get(did)).toEqual([...traded, `show Ended ${why}`])
      }
    }),
  )

  it.effect('stops waiting on a trade that stalls, after fifteen seconds', () =>
    Effect.gen(function* () {
      const did = yield* run({
        begin: Effect.succeed('opened'),
        ended: Effect.succeed(granted),
        trade: Effect.never,
      })
      yield* TestClock.adjust('14 seconds')
      expect(yield* Ref.get(did)).toEqual(traded)
      yield* TestClock.adjust('1 second')
      expect(yield* Ref.get(did)).toEqual([...traded, 'show Ended unreachable'])
    }),
  )

  it.effect('goes back to the form, saying nothing, when the shell says it was cancelled', () =>
    Effect.gen(function* () {
      const did = yield* run({
        begin: Effect.succeed('opened'),
        ended: Effect.succeed(SignInEnding.cases.Cancelled.make({})),
        trade: Effect.succeed({ arrival: 'returning' }),
      })
      expect(yield* Ref.get(did)).toEqual([...opened, 'leave'])
    }),
  )
})

describe('what the shell hands over is not trusted', () => {
  it.effect(
    'sends nothing to the server when the three values are not in the contract’s form',
    () =>
      Effect.gen(function* () {
        for (const values of [
          { ...handed, code: 'short' },
          { ...handed, state: `${STATE}!` },
          { ...handed, verifier: 'not 43 of base64url' },
        ]) {
          const did = yield* run({
            begin: Effect.succeed('opened'),
            ended: Effect.succeed(SignInEnding.cases.Granted.make(values)),
            trade: Effect.succeed({ arrival: 'returning' }),
          })
          // Never "Signing you in…": the card goes from waiting straight to the refusal.
          expect(yield* Ref.get(did)).toEqual([...opened, 'show Ended refused'])
        }
      }),
  )

  it.effect(
    'ends as refused, and waits for nothing, when the shell cannot be read at the start',
    () =>
      Effect.gen(function* () {
        const did = yield* run({
          begin: Effect.fail(new ShellUnreadable({})),
          ended: Effect.succeed(granted),
          trade: Effect.succeed({ arrival: 'returning' }),
        })
        expect(yield* Ref.get(did)).toEqual(['show Opening', 'begin', 'show Ended refused'])
      }),
  )

  it.effect('ends as refused when how it ended cannot be read', () =>
    Effect.gen(function* () {
      const did = yield* run({
        begin: Effect.succeed('opened'),
        ended: Effect.fail(new ShellUnreadable({})),
        trade: Effect.succeed({ arrival: 'returning' }),
      })
      expect(yield* Ref.get(did)).toEqual([...opened, 'show Ended refused'])
    }),
  )

  it.effect('reads what the shell answers about the browser, and nothing else as that', () =>
    Effect.gen(function* () {
      expect(yield* browserSaid(() => Promise.resolve('opened'))).toBe('opened')
      expect(yield* browserSaid(() => Promise.resolve('unopened'))).toBe('unopened')
      for (const answer of ['maybe', true, { browser: 'opened' }])
        expect(yield* Effect.flip(browserSaid(() => Promise.resolve(answer)))).toBeInstanceOf(
          ShellUnreadable,
        )
      expect(
        yield* Effect.flip(browserSaid(() => Promise.reject(new Error('refused by the shell')))),
      ).toBeInstanceOf(ShellUnreadable)
    }),
  )

  it.effect('reads how the shell says it ended, and nothing else as that', () =>
    Effect.gen(function* () {
      expect(yield* endingSaid(() => Promise.resolve(granted))).toEqual(granted)
      // The values with no ending named, a code with one of its values empty, and no ending at all.
      for (const answer of [handed, { ...granted, verifier: '' }, 'done'])
        expect(yield* Effect.flip(endingSaid(() => Promise.resolve(answer)))).toBeInstanceOf(
          ShellUnreadable,
        )
      expect(
        yield* Effect.flip(endingSaid(() => Promise.reject(new Error('refused by the shell')))),
      ).toBeInstanceOf(ShellUnreadable)
    }),
  )
})

describe('opening a browser that did not open', () => {
  const waiting: Shown = {
    attempt: 3,
    state: Option.some(Handing.Waiting({ browser: 'unopened' })),
  }

  it.effect('answers what the shell said, and "did not open" when it cannot be read', () =>
    Effect.gen(function* () {
      expect(yield* reopening(Effect.succeed('opened'))).toBe('opened')
      expect(yield* reopening(Effect.succeed('unopened'))).toBe('unopened')
      expect(yield* reopening(Effect.fail(new ShellUnreadable({})))).toBe('unopened')
    }),
  )

  it('changes what a card still waiting on that attempt says', () => {
    expect(reopened(waiting, 3, 'opened')).toEqual({
      attempt: 3,
      state: Option.some(Handing.Waiting({ browser: 'opened' })),
    })
  })

  it('leaves alone a card that has moved on while the browser was opening', () => {
    for (const state of [
      Handing.Finishing(),
      Handing.Ended({ why: 'failed' }),
      Handing.Opening(),
    ]) {
      const moved: Shown = { attempt: 3, state: Option.some(state) }
      expect(reopened(moved, 3, 'opened')).toBe(moved)
    }
  })

  it('leaves alone the form after a cancel, and a later attempt', () => {
    const form: Shown = { attempt: 4, state: Option.none() }
    expect(reopened(form, 3, 'opened')).toBe(form)
    const later: Shown = { attempt: 4, state: Option.some(Handing.Waiting({ browser: 'opened' })) }
    expect(reopened(later, 3, 'unopened')).toBe(later)
  })
})

describe('where the app starts again once signed in', () => {
  it('is where a returning Person was going', () => {
    expect(landing('/threads/abc?tab=files', 'returning')).toBe('/threads/abc?tab=files')
  })

  it('is the same place marked as a first Google arrival, so the time zone is adopted', () => {
    expect(landing('/threads/abc?tab=files', 'first')).toBe('/threads/abc?tab=files&joined=google')
    expect(landing('/', 'first')).toBe('/?joined=google')
  })
})

describe('which way a window signs in with Google', () => {
  const signIn = {
    begin: () => Promise.resolve('opened' as const),
    reopen: () => Promise.resolve('opened' as const),
    ended: () => Promise.resolve(SignInEnding.cases.Cancelled.make({})),
    cancel: () => Promise.resolve(),
  }

  it('is a redirect in a browser tab, where there is no desktop bridge', () => {
    expect(wayIn(Option.none())).toEqual(Way.Browser())
  })

  it('is the hand-off in a desktop app whose bridge can sign in through the browser', () => {
    expect(wayIn(Option.some({ signIn, getAppVersion: () => Promise.resolve('1.0.0') }))).toEqual(
      Way.Shell({ signIn }),
    )
  })

  it('is not offered in a desktop app whose bridge cannot', () => {
    expect(wayIn(Option.some({}))).toEqual(Way.Unable())
    // The shell that came before this one had another capability in its place.
    expect(wayIn(Option.some({ openExternal: () => Promise.resolve() }))).toEqual(Way.Unable())
    // A bridge read off the window is whatever that shell put there, whatever its type says.
    expect(wayIn(Option.some({ signIn: { ...signIn, ended: 'not a function' } }))).toEqual(
      Way.Unable(),
    )
    expect(wayIn(Option.some({ signIn: { begin: signIn.begin } }))).toEqual(Way.Unable())
    expect(wayIn(Option.some('not a bridge'))).toEqual(Way.Unable())
  })
})
