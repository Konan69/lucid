import { describe, expect, layer } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Result from 'effect/Result'
import {
  Appearance,
  DEFAULT_APPEARANCE,
  Forbidden,
  Look,
  SessionId,
  Workspace,
  type Person,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { fixture, trustTestLayer } from '../approvals/testing.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { companyStoreLayer } from '../companies/store.ts'
import { settingsStoreLayer } from '../settings/store.ts'
import { appearanceHandlers } from './handlers.ts'
import { appearanceStoreLayer } from './store.ts'

const testLayer = appearanceStoreLayer.pipe(
  Layer.provideMerge(Layer.merge(settingsStoreLayer, companyStoreLayer)),
  Layer.provideMerge(trustTestLayer),
)

/** A signed-in Person working in one workspace, as the RPC middleware would hand it over. */
const signedIn = (actor: { readonly person: Person; readonly workspace: Workspace }) =>
  Effect.provideService(
    AuthContext,
    AuthState.Person({
      person: actor.person,
      workspace: actor.workspace,
      sessionId: SessionId.make('test-session'),
    }),
  )

const teal = new Appearance({
  name: 'Juno',
  look: Look.cases.Hue.make({ hue: 'cyan' }),
  outline: 'hexagon',
})

/** Whose Vivid a workspace shows, and who may change it. */
describe.skipIf(!testDatabaseConfigured)('Vivid appearance', () => {
  layer(testLayer)((it) => {
    it.effect(
      'a Person names and colours their own Vivid, and a Company is not changed by it',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          expect(yield* appearanceHandlers.GetAppearance().pipe(signedIn(test.personal))).toEqual(
            DEFAULT_APPEARANCE,
          )
          const saved = yield* appearanceHandlers.SetAppearance(teal).pipe(signedIn(test.personal))
          expect(saved).toEqual(teal)
          expect(yield* appearanceHandlers.GetAppearance().pipe(signedIn(test.personal))).toEqual(
            teal,
          )
          // The same Person, working in the Company, sees the Company's Vivid: still the default.
          expect(yield* appearanceHandlers.GetAppearance().pipe(signedIn(test.member))).toEqual(
            DEFAULT_APPEARANCE,
          )
        }).pipe(Effect.scoped),
    )

    it.effect('only an owner or admin changes a Company’s Vivid, and every Member sees it', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const refused = yield* Effect.result(
          appearanceHandlers.SetAppearance(teal).pipe(signedIn(test.member)),
        )
        expect(Result.isFailure(refused)).toBe(true)
        if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(Forbidden)
        yield* appearanceHandlers.SetAppearance(teal).pipe(signedIn(test.owner))
        expect(yield* appearanceHandlers.GetAppearance().pipe(signedIn(test.member))).toEqual(teal)
        if (!Workspace.guards.Company(test.owner.workspace)) expect.fail('Company required')
        const admin = {
          person: test.owner.person,
          workspace: Workspace.cases.Company.make({
            company: test.owner.workspace.company,
            role: 'admin',
          }),
        }
        yield* appearanceHandlers.SetAppearance(DEFAULT_APPEARANCE).pipe(signedIn(admin))
        expect(yield* appearanceHandlers.GetAppearance().pipe(signedIn(test.member))).toEqual(
          DEFAULT_APPEARANCE,
        )
        // The owner's personal space has its own Vivid, untouched by the Company's.
        expect(
          yield* appearanceHandlers
            .GetAppearance()
            .pipe(signedIn({ person: test.owner.person, workspace: test.personal.workspace })),
        ).toEqual(DEFAULT_APPEARANCE)
      }).pipe(Effect.scoped),
    )

    it.effect('Vivid reads the name it was given and cannot rename itself', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        yield* appearanceHandlers.SetAppearance(teal).pipe(signedIn(test.personal))
        const asVivid = Effect.provideService(
          AuthContext,
          AuthState.Vivid({
            person: test.personal.person,
            workspace: test.personal.workspace,
            threadId: test.personalId,
          }),
        )
        expect((yield* appearanceHandlers.GetAppearance().pipe(asVivid)).name).toBe('Juno')
        const refused = yield* Effect.result(
          appearanceHandlers.SetAppearance(DEFAULT_APPEARANCE).pipe(asVivid),
        )
        expect(Result.isFailure(refused)).toBe(true)
        if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(Forbidden)
      }).pipe(Effect.scoped),
    )
  })
})
