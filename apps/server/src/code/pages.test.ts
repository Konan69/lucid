import { expect, it } from '@effect/vitest'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Person, PersonId, ReadPageOutcome, SessionId, Workspace } from '@vivid/contracts'
import { Deferred, Effect, Fiber, Ref } from 'effect'
import { budgets } from './budgets.ts'
import { PageReader } from './page.ts'
import { readPage } from './pages.ts'
import { codeHandlers } from './handlers.ts'

/** Queued Promise.all reads wait for one of eight slots and interruption releases a permit. */
it.effect('queues page reads beyond global capacity and releases slots after interruption', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const count = yield* Ref.make(0)
    const reader = PageReader.of({
      read: Effect.fn('Test.waitForPage')(function* () {
        const current = yield* Ref.updateAndGet(count, (value) => value + 1)
        if (current === budgets.pages) yield* Deferred.succeed(entered, undefined)
        if (current > budgets.pages)
          return ReadPageOutcome.cases.Refused.make({ reason: 'not a readable page' })
        return yield* Effect.never
      }),
    })
    const fibers = yield* Effect.forEach(Array.from({ length: budgets.pages }), () =>
      readPage({ address: 'https://example.com/' }).pipe(
        Effect.provideService(PageReader, reader),
        Effect.forkChild,
      ),
    )
    yield* Deferred.await(entered)
    const queued = yield* Effect.forkChild(
      readPage({ address: 'https://example.com/' }).pipe(Effect.provideService(PageReader, reader)),
      { startImmediately: true },
    )
    expect(yield* Ref.get(count)).toBe(budgets.pages)
    for (const fiber of fibers) yield* Fiber.interrupt(fiber)
    expect(yield* Fiber.join(queued)).toHaveProperty('reason', 'not a readable page')
    expect(yield* Ref.get(count)).toBe(budgets.pages + 1)
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
