import { describe, expect, it } from '@effect/vitest'
import {
  BrowserAction,
  Device,
  DeviceAccess,
  DeviceAnswer,
  DeviceId,
  DeviceName,
  DevicePresence,
  DeviceRequest,
  DeviceRequestId,
  RunId,
  ThreadId,
  type AnswerDeviceRequest,
} from '@vivid/contracts'
import type * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Redacted from 'effect/Redacted'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { DeviceLink } from '../shared/device.ts'
import {
  LinkDown,
  LinkSignedOut,
  cookieHeader,
  liveAddress,
  deviceLink,
  type DeviceServer,
  type LinkFailure,
} from './device.ts'

const id = DeviceId.make('0b6f2a3e-8f0e-4d7e-9a53-6f1f2a100d8f')
const device = (access: DeviceAccess) =>
  Device.make({
    id,
    name: DeviceName.make('ada-laptop'),
    access,
    presence: DevicePresence.cases.Offline.make({}),
  })
const pending = device(DeviceAccess.cases.Pending.make({ since: 0 }))
const allowed = device(DeviceAccess.cases.Allowed.make({ since: 0 }))
const revoked = device(DeviceAccess.cases.Revoked.make({ since: 0 }))

const request = DeviceRequest.make({
  id: DeviceRequestId.make('3f0e2f52-6d0f-4c0f-9a34-6f6b3c0f8a11'),
  threadId: ThreadId.make('thread-1'),
  runId: RunId.make('run-1'),
  action: BrowserAction.cases.Read.make({}),
  expiresAt: 30_000,
})
const failed = DeviceAnswer.cases.Failed.make({})

/**
 * A server that answers each enrolment with the next scripted answer and reports what the link
 * did to it, in order, on a queue the test waits on. Waiting on the queue is the test's signal:
 * nothing here sleeps or polls.
 */
const fixture = Effect.fn('fixture')(function* (options: {
  readonly enrolments: ReadonlyArray<Effect.Effect<Device, LinkFailure>>
  readonly signedIn?: () => boolean
  readonly execute?: Option.Option<DeviceAnswer>
}) {
  const heard = yield* Queue.unbounded<string>()
  const requests = yield* Queue.unbounded<DeviceRequest, LinkFailure | Cause.Done>()
  const answers: Array<AnswerDeviceRequest> = []
  let enrolled = 0
  const server: DeviceServer = {
    enrol: Effect.suspend(() => {
      const next = options.enrolments[Math.min(enrolled, options.enrolments.length - 1)]
      enrolled += 1
      Queue.offerUnsafe(heard, 'enrol')
      return next === undefined ? Effect.fail(new LinkDown({})) : next
    }),
    watch: () => {
      Queue.offerUnsafe(heard, 'watch')
      return Stream.fromQueue(requests)
    },
    answer: (answer) =>
      Effect.sync(() => {
        answers.push(answer)
        Queue.offerUnsafe(heard, 'answer')
      }),
  }
  const signedIn = options.signedIn === undefined ? () => true : options.signedIn
  const link = yield* deviceLink({
    connect: Effect.sync(() => (signedIn() ? Option.some(server) : Option.none())),
    execute: () =>
      Effect.sync(() => {
        Queue.offerUnsafe(heard, 'execute')
        return options.execute === undefined ? Option.some(failed) : options.execute
      }),
  })
  yield* Effect.forkScoped(link.run)
  return { link, heard, requests, answers, next: Queue.take(heard) }
})

describe('this computer’s link to Vivid', () => {
  it('sends the session’s cookies as a browser would, and nothing when there are none', () => {
    expect(Option.isNone(cookieHeader([]))).toBe(true)
    expect(
      Option.map(
        cookieHeader([
          { name: 'vivid.session_token', value: 'abc' },
          { name: 'vivid.session_data', value: 'def' },
        ]),
        Redacted.value,
      ),
    ).toEqual(Option.some('vivid.session_token=abc; vivid.session_data=def'))
    expect(liveAddress('https://vivid.example')).toBe('wss://vivid.example/api/live')
    expect(liveAddress('http://127.0.0.1:5178')).toBe('ws://127.0.0.1:5178/api/live')
  })

  it.effect('enrols, waits to be allowed, then listens and answers on the same connection', () =>
    Effect.gen(function* () {
      const { link, next, requests, answers } = yield* fixture({
        enrolments: [Effect.succeed(pending), Effect.succeed(allowed)],
      })
      expect(yield* next).toBe('enrol')
      yield* TestClock.adjust('999 millis')
      // Enrolling grants nothing: it is waiting, and has not listened.
      expect(link.state()).toEqual(DeviceLink.cases.Waiting.make({ device: id }))
      yield* TestClock.adjust('1 millis')
      expect(yield* next).toBe('enrol')
      expect(yield* next).toBe('watch')
      expect(link.state()).toEqual(DeviceLink.cases.Linked.make({ device: id }))
      yield* Queue.offer(requests, request)
      expect(yield* next).toBe('execute')
      expect(yield* next).toBe('answer')
      expect(answers).toEqual([{ device: id, id: request.id, answer: failed }])
    }),
  )

  it.effect('an action whose deadline passed is not answered', () =>
    Effect.gen(function* () {
      const { next, requests, answers } = yield* fixture({
        enrolments: [Effect.succeed(allowed)],
        execute: Option.none(),
      })
      expect(yield* next).toBe('enrol')
      expect(yield* next).toBe('watch')
      yield* Queue.offer(requests, request)
      expect(yield* next).toBe('execute')
      yield* Queue.offer(requests, request)
      expect(yield* next).toBe('execute')
      expect(answers).toEqual([])
    }),
  )

  it.effect('signed out, it rests: no retries until something changes', () =>
    Effect.gen(function* () {
      let signedIn = false
      const { link, heard, next } = yield* fixture({
        enrolments: [Effect.succeed(allowed)],
        signedIn: () => signedIn,
      })
      yield* TestClock.adjust('10 minutes')
      expect(link.state()).toEqual(DeviceLink.cases.SignedOut.make({}))
      expect(yield* Queue.size(heard)).toBe(0)
      signedIn = true
      link.wake()
      expect(yield* next).toBe('enrol')
      expect(yield* next).toBe('watch')
    }),
  )

  it.effect('a session the server no longer knows rests like being signed out', () =>
    Effect.gen(function* () {
      const { link, heard, next } = yield* fixture({
        enrolments: [Effect.fail(new LinkSignedOut({}))],
      })
      expect(yield* next).toBe('enrol')
      yield* TestClock.adjust('10 minutes')
      expect(link.state()).toEqual(DeviceLink.cases.SignedOut.make({}))
      expect(yield* Queue.size(heard)).toBe(0)
    }),
  )

  it.effect('an unreachable server is tried again after 1, 2 and 4 seconds, then links', () =>
    Effect.gen(function* () {
      const down = Effect.fail(new LinkDown({}))
      const { link, heard, next } = yield* fixture({
        enrolments: [down, down, down, Effect.succeed(allowed)],
      })
      expect(yield* next).toBe('enrol')
      expect(link.state()).toEqual(DeviceLink.cases.Unreachable.make({}))
      for (const wait of ['1 second', '2 seconds', '4 seconds'] as const) {
        expect(yield* Queue.size(heard)).toBe(0)
        yield* TestClock.adjust(wait)
        expect(yield* next).toBe('enrol')
      }
      expect(yield* next).toBe('watch')
      expect(link.state()).toEqual(DeviceLink.cases.Linked.make({ device: id }))
    }),
  )

  it.effect('when the server ends the link it looks again, and stops for good once revoked', () =>
    Effect.gen(function* () {
      const { link, heard, next, requests } = yield* fixture({
        enrolments: [Effect.succeed(allowed), Effect.succeed(revoked)],
      })
      expect(yield* next).toBe('enrol')
      expect(yield* next).toBe('watch')
      yield* Queue.end(requests)
      yield* TestClock.adjust('1 second')
      expect(yield* next).toBe('enrol')
      yield* TestClock.adjust('10 minutes')
      expect(link.state()).toEqual(DeviceLink.cases.Revoked.make({ device: id }))
      expect(yield* Queue.size(heard)).toBe(0)
    }),
  )

  it.effect('a wake never drops a link that is listening; a restart does', () =>
    Effect.gen(function* () {
      const { link, heard, next } = yield* fixture({ enrolments: [Effect.succeed(allowed)] })
      expect(yield* next).toBe('enrol')
      expect(yield* next).toBe('watch')
      link.wake()
      yield* TestClock.adjust('1 minute')
      expect(yield* Queue.size(heard)).toBe(0)
      link.restart()
      expect(yield* next).toBe('enrol')
      expect(yield* next).toBe('watch')
    }),
  )
})
