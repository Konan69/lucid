import { expect, it } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Person, PersonId, ReadPageOutcome, SessionId, Workspace } from '@vivid/contracts'
import { Deferred, Effect, Fiber, Ref } from 'effect'
import { PageReader } from './page.ts'
import { readPage } from './pages.ts'
import { codeHandlers } from './handlers.ts'

/** Saturation is signaled by the reader; no real-time polling or network timeout drives admission. */
it.effect('bounds public page reads globally and releases capacity after interruption', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const count = yield* Ref.make(0)
    const reader = PageReader.of({
      read: Effect.fn('Test.waitForPage')(function* () {
        const current = yield* Ref.updateAndGet(count, (value) => value + 1)
        if (current === 4) yield* Deferred.succeed(entered, undefined)
        return yield* Effect.never
      }),
    })
    const fibers = yield* Effect.forEach([1, 2, 3, 4], () =>
      readPage({ address: 'https://example.com/' }).pipe(
        Effect.provideService(PageReader, reader),
        Effect.forkChild,
      ),
    )
    yield* Deferred.await(entered)
    expect(
      ReadPageOutcome.guards.Refused(
        yield* readPage({ address: 'https://example.com/' }).pipe(
          Effect.provideService(PageReader, reader),
        ),
      ),
    ).toBe(true)
    expect(yield* Ref.get(count)).toBe(4)
    yield* Effect.forEach(fibers, (fiber) => Fiber.interrupt(fiber))
    const ready = PageReader.of({
      read: () =>
        Effect.succeed(ReadPageOutcome.cases.Refused.make({ reason: 'not a readable page' })),
    })
    expect(
      yield* readPage({ address: 'https://example.com/' }).pipe(
        Effect.provideService(PageReader, ready),
      ),
    ).toHaveProperty('reason', 'not a readable page')
  }),
)

/** Person sessions cannot turn the RPC into an unmetered public-address fetch proxy. */
it.effect('refuses Person-only ReadPage before any network read', () =>
  Effect.gen(function* () {
    const state = AuthState.Person({
      person: Person.make({
        id: PersonId.make('page-person'),
        name: 'Ada',
        email: 'ada@example.test',
        image: null,
      }),
      workspace: Workspace.cases.Personal.make({}),
      sessionId: SessionId.make('page-session'),
    })
    const reader = PageReader.of({ read: () => Effect.die('Person must not reach network') })
    const failure = yield* codeHandlers
      .ReadPage({ address: 'https://example.com/' })
      .pipe(
        Effect.provideService(AuthContext, state),
        Effect.provideService(PageReader, reader),
        Effect.flip,
      )
    expect(failure._tag).toBe('Forbidden')
  }),
)
