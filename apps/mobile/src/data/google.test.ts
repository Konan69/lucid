import * as NodeCrypto from 'node:crypto'
import { describe, expect, it } from '@effect/vitest'
import {
  phoneSignInReturnAddress,
  PHONE_SIGN_IN_RETURN,
  SignInAttempt,
  SignInCode,
  SignInReturn,
} from '@vivid/contracts/signin'
import { Deferred, Effect, Fiber, Redacted, Result, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  ATTEMPT_LASTS,
  attemptName,
  base64url,
  challengeText,
  makeGoogle,
  PhoneUnable,
  Standing,
  TRADE_WITHIN,
  TradeUnanswered,
  type Answer,
} from './google.ts'
import { parseServer, type ServerAddress } from './server.ts'

const server = Result.getOrThrow(parseServer('https://vivid.example.com'))
const CODE = SignInCode.make('c'.repeat(32))

/** The store's refusal to keep a session. */
class Locked extends Schema.TaggedError<Locked>()('Locked', {}, { title: 'Store locked' }) {}

const Posted = Schema.fromJsonString(
  Schema.Struct({ code: Schema.String, state: Schema.String, verifier: Schema.String }),
)
const decodePosted = Schema.decodeUnknownEffect(Posted)

/** What a test's phone does at the places a sign-in can go more than one way. */
interface Script {
  /** Whether the browser opens. */
  readonly open: Effect.Effect<void, PhoneUnable>
  /** The server's answer to the trade. */
  readonly answer: Effect.Effect<Answer, TradeUnanswered>
  /** Whether the phone's store keeps the session. */
  readonly keep: Effect.Effect<void, Locked>
}

const works: Script = {
  open: Effect.void,
  answer: Effect.succeed({ ok: true, body: JSON.stringify({ token: 'session-token' }) }),
  keep: Effect.void,
}

/** Everything a test can look at afterwards. */
interface Seen {
  standing: Standing
  readonly browser: Array<URL>
  readonly posted: Array<{ readonly address: string; readonly body: string }>
  readonly adopted: Array<{ readonly server: ServerAddress; readonly token: string }>
}

/**
 * One phone at the front door, as a sign-in sees it. Its random bytes and digest are Node's own,
 * so the secret and the challenge are real and a test can check one against the other the way
 * the server does. The browser is a list of the addresses it was opened on; `opened` is its
 * receipt that the latest press reached it. Where the sign-in stands is one variable, the way
 * `signing.ts` gives it one atom.
 */
const makeDoor = Effect.fn('Test.makeDoor')(function* (script: Script) {
  const seen: Seen = { standing: Standing.Idle(), browser: [], posted: [], adopted: [] }
  let opened = yield* Deferred.make<void>()
  const google = makeGoogle(
    {
      random: (count) => Effect.sync(() => new Uint8Array(NodeCrypto.randomBytes(count))),
      digest: (text) =>
        Effect.sync(() => NodeCrypto.createHash('sha256').update(text).digest('base64')),
      open: (address) =>
        Effect.gen(function* () {
          seen.browser.push(new URL(address))
          yield* script.open
          yield* Deferred.succeed(opened, undefined)
        }),
      post: (address, body) => {
        seen.posted.push({ address, body })
        return script.answer
      },
    },
    {
      standing: () => seen.standing,
      show: (next) => {
        seen.standing = next
      },
      adopt: (at, token) => {
        seen.adopted.push({ server: at, token: Redacted.value(token) })
        return script.keep
      },
    },
  )
  /** Presses the button and waits until the browser has been asked to open. */
  const press = Effect.fn('Test.press')(function* () {
    opened = yield* Deferred.make<void>()
    const pressing = yield* Effect.forkChild(google.start(server))
    yield* Deferred.await(opened)
    return pressing
  })
  /** The name of the attempt being waited on, which a test fails without. */
  const waitingOn = Effect.sync(() => {
    if (!Standing.$is('Away')(seen.standing)) throw new Error('no attempt is being waited on')
    return seen.standing.attempt.state
  })
  return { google, seen, press, waitingOn }
})

/** The link the server sends the browser to when Google signed the Person in. */
const granted = (state: SignInAttempt) =>
  phoneSignInReturnAddress(SignInReturn.cases.Granted.make({ code: CODE, state }))

describe('base64url', () => {
  it('writes bytes the way RFC 4648 does, URL-safe and without padding', () => {
    const text = (ascii: string) => base64url(new TextEncoder().encode(ascii))
    // The RFC's own test vectors (section 10), with the padding dropped.
    expect(['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map(text)).toEqual([
      '',
      'Zg',
      'Zm8',
      'Zm9v',
      'Zm9vYg',
      'Zm9vYmE',
      'Zm9vYmFy',
    ])
    // The two characters that differ from standard base64.
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-')
  })

  it('agrees with Node for every length of random bytes up to a secret’s', () => {
    for (let length = 0; length <= 32; length += 1) {
      const bytes = NodeCrypto.randomBytes(length)
      expect(base64url(new Uint8Array(bytes))).toBe(bytes.toString('base64url'))
    }
  })
})

it('turns a standard base64 digest into the challenge the server computes', () => {
  const digest = NodeCrypto.createHash('sha256').update('a secret').digest()
  expect(challengeText(digest.toString('base64'))).toBe(digest.toString('base64url'))
})

it('names an attempt in letters and digits only, one for each byte', () => {
  const every = Uint8Array.from({ length: 256 }, (_, byte) => byte)
  expect(attemptName(every)).toMatch(/^[A-Za-z0-9]{256}$/u)
  expect(attemptName(new Uint8Array(NodeCrypto.randomBytes(16)))).toHaveLength(16)
})

describe('signing in with Google', () => {
  it.effect('opens the browser on the server’s start address and waits', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor(works)
      yield* door.press()
      const state = yield* door.waitingOn
      const [address] = door.seen.browser
      expect(address).toBeDefined()
      if (address === undefined) return
      expect(address.origin).toBe('https://vivid.example.com')
      expect(address.pathname).toBe('/api/auth/phone/google')
      expect(address.searchParams.get('state')).toBe(state)
      expect(door.seen.posted).toEqual([])
    }),
  )

  it.effect('trades the code that comes back with the secret, and takes up the session', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor(works)
      yield* door.press()
      const state = yield* door.waitingOn
      yield* door.google.returned(granted(state))

      expect(door.seen.adopted).toEqual([{ server, token: 'session-token' }])
      expect(door.seen.standing).toEqual(Standing.Idle())

      const [address] = door.seen.browser
      const [posted] = door.seen.posted
      expect(posted).toBeDefined()
      if (address === undefined || posted === undefined) return
      expect(posted.address).toBe('https://vivid.example.com/api/auth/phone/session')
      // The server's own check: the secret traded hashes to the challenge the browser carried,
      // and the secret itself was never on the address.
      const sent = yield* decodePosted(posted.body)
      expect(sent.code).toBe(CODE)
      expect(sent.state).toBe(state)
      expect(NodeCrypto.createHash('sha256').update(sent.verifier).digest('base64url')).toBe(
        address.searchParams.get('challenge'),
      )
      expect(address.href).not.toContain(sent.verifier)
    }),
  )

  it.effect('answers the same link once', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor(works)
      yield* door.press()
      const link = granted(yield* door.waitingOn)
      yield* door.google.returned(link)
      yield* door.google.returned(link)
      expect(door.seen.posted).toHaveLength(1)
      expect(door.seen.adopted).toHaveLength(1)
    }),
  )

  it.effect('ignores every link that is not the waiting attempt’s return', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor(works)
      yield* door.press()
      const state = yield* door.waitingOn
      const away = door.seen.standing
      for (const link of [
        granted(SignInAttempt.make('A'.repeat(16))),
        `vivid://elsewhere?state=${state}&code=${CODE}`,
        `${PHONE_SIGN_IN_RETURN}?state=${state}&code=short`,
        PHONE_SIGN_IN_RETURN,
        'https://vivid.example.com/invite/abc',
      ]) {
        yield* door.google.returned(link)
      }
      expect(door.seen.standing).toBe(away)
      expect(door.seen.posted).toEqual([])
    }),
  )

  it.effect('ignores a link when no attempt is being waited on', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor(works)
      yield* door.google.returned(granted(SignInAttempt.make('A'.repeat(16))))
      expect(door.seen.standing).toEqual(Standing.Idle())
      expect(door.seen.posted).toEqual([])
    }),
  )

  it.effect('replaces the attempt when the button is pressed again', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor(works)
      const first = yield* door.press()
      const old = yield* door.waitingOn
      // What a function atom does to its last run when it is written to again.
      yield* Fiber.interrupt(first)
      yield* door.press()
      const current = yield* door.waitingOn
      expect(current).not.toBe(old)

      // The browser tab of the first attempt finishing late is not this attempt's answer.
      yield* door.google.returned(granted(old))
      expect(door.seen.posted).toEqual([])
      yield* door.google.returned(granted(current))
      expect(door.seen.adopted).toHaveLength(1)
    }),
  )

  it.effect('drops an attempt after five minutes, and its link with it', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor(works)
      const pressing = yield* door.press()
      const state = yield* door.waitingOn
      yield* TestClock.adjust(ATTEMPT_LASTS)
      yield* Fiber.join(pressing)
      expect(door.seen.standing).toEqual(Standing.Idle())
      yield* door.google.returned(granted(state))
      expect(door.seen.posted).toEqual([])
    }),
  )

  it.effect('leaves a newer attempt alone when an older one’s time runs out', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor(works)
      // A first press whose run was not stopped, the case `start` must be harmless in.
      const first = yield* door.press()
      yield* TestClock.adjust('4 minutes')
      yield* door.press()
      const current = yield* door.waitingOn
      yield* TestClock.adjust('1 minute')
      yield* Fiber.join(first)
      expect(yield* door.waitingOn).toBe(current)
    }),
  )

  it.effect('says it did not finish when the server sends the browser back with an error', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor(works)
      yield* door.press()
      const state = yield* door.waitingOn
      yield* door.google.returned(
        phoneSignInReturnAddress(SignInReturn.cases.Failed.make({ state })),
      )
      expect(door.seen.standing).toEqual(Standing.Failed())
      expect(door.seen.posted).toEqual([])
    }),
  )

  it.effect('says it did not finish when the browser cannot be opened', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor({ ...works, open: Effect.fail(new PhoneUnable({})) })
      yield* door.google.start(server)
      expect(door.seen.standing).toEqual(Standing.Failed())
    }),
  )

  it.effect('says it did not finish when the trade is refused or answers without a token', () =>
    Effect.gen(function* () {
      const answers: ReadonlyArray<Answer> = [
        { ok: false, body: '' },
        { ok: true, body: '{}' },
        { ok: true, body: '{"token":""}' },
        { ok: true, body: 'not json' },
      ]
      for (const answer of answers) {
        const door = yield* makeDoor({ ...works, answer: Effect.succeed(answer) })
        yield* door.press()
        yield* door.google.returned(granted(yield* door.waitingOn))
        expect(door.seen.standing).toEqual(Standing.Failed())
        expect(door.seen.adopted).toEqual([])
      }
    }),
  )

  it.effect('says Vivid cannot be reached when the trade gets no answer', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor({ ...works, answer: Effect.fail(new TradeUnanswered({})) })
      yield* door.press()
      yield* door.google.returned(granted(yield* door.waitingOn))
      expect(door.seen.standing).toEqual(Standing.Unreachable())
    }),
  )

  it.effect('is busy while the trade runs, and stops waiting for one that never answers', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor({ ...works, answer: Effect.never })
      yield* door.press()
      const returning = yield* Effect.forkChild(
        door.google.returned(granted(yield* door.waitingOn)),
      )
      yield* TestClock.adjust(0)
      expect(door.seen.standing).toEqual(Standing.Trading())
      // A press now is not offered, and does nothing if it happens.
      yield* door.google.start(server)
      expect(door.seen.browser).toHaveLength(1)
      yield* TestClock.adjust(TRADE_WITHIN)
      yield* Fiber.join(returning)
      expect(door.seen.standing).toEqual(Standing.Unreachable())
    }),
  )

  it.effect('says the phone could not save the sign-in when its store refuses', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor({ ...works, keep: Effect.fail(new Locked({})) })
      yield* door.press()
      yield* door.google.returned(granted(yield* door.waitingOn))
      expect(door.seen.standing).toEqual(Standing.Unkept())
    }),
  )

  it.effect('takes an earlier attempt’s sentence away when a new one starts', () =>
    Effect.gen(function* () {
      const door = yield* makeDoor(works)
      door.seen.standing = Standing.Failed()
      yield* door.press()
      expect(Standing.$is('Away')(door.seen.standing)).toBe(true)
    }),
  )
})
