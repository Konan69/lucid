import { expect, layer } from '@effect/vitest'
import { SignInStart, SignInReturn, signInReturnAddress } from '@vivid/contracts/signin'
import * as NodeCrypto from 'node:crypto'
import * as NodeURL from 'node:url'
import { Effect, Queue, Result, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import { SignInEnding } from '../shared/bridge.ts'
import { ServerAddress, ServerSettings } from '../shared/settings.ts'
import { googleSignIn } from './signin.ts'
import { loadThemeSurfaces } from './tokens.ts'

const decodeStart = Schema.decodeUnknownEffect(SignInStart)

/** Real loopback callbacks remain receivable while a Person takes time in the external browser. */
layer(FetchHttpClient.layer)((it) => {
  it.effect('accepts a sign-in callback after six minutes and serves its final page', () =>
    Effect.gen(function* () {
      const opened = yield* Queue.unbounded<string>()
      const surfaces = yield* loadThemeSurfaces(
        NodeURL.fileURLToPath(
          new URL('../../../../packages/design/tokens/src/tokens.css', import.meta.url),
        ),
      )
      const signIn = yield* googleSignIn({
        server: () =>
          ServerSettings.cases.Server.make({ origin: ServerAddress.make('https://vivid.example') }),
        open: (address) => Queue.offer(opened, address).pipe(Effect.asVoid),
        random: (size) => NodeCrypto.randomBytes(size),
        focus: () => undefined,
        surfaces,
      })
      expect(yield* signIn.begin).toBe('opened')
      const address = new URL(yield* Queue.take(opened))
      const start = yield* decodeStart(Object.fromEntries(address.searchParams))
      yield* TestClock.adjust('6 minutes')
      const returned = yield* HttpClient.get(
        signInReturnAddress(start.port, SignInReturn.cases.Failed.make({ state: start.state })),
      ).pipe(Effect.result)
      expect(Result.isSuccess(returned)).toBe(true)
      if (Result.isFailure(returned)) return
      expect(returned.success.status).toBe(200)
      expect(yield* signIn.ended).toEqual(SignInEnding.cases.Failed.make({}))
    }),
  )
})
