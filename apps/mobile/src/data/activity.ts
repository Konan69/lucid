import { awareness } from './awareness'
import { VividRpcClient } from '@vivid/client-runtime'
import { ActivityRegistration, ActivityToken } from '@vivid/contracts'
import type { makeLive } from '@vivid/state'
import { Effect, Option, Redacted, Result, Schema } from 'effect'
import { randomUUID } from 'expo-crypto'
import { launch } from './app'
import type { SignedIn } from './session'
import { keepFile, recallFile, forgetFile } from './storage'

const TokenEvent = Schema.Struct({
  kind: Schema.Literals(['Start', 'Update']),
  token: ActivityToken,
})

const decodeToken = Schema.decodeEffect(TokenEvent)

/** Native ActivityKit owns observation and buttons. JavaScript only binds its rotating addresses. */
export const followActivities = (engine: ReturnType<typeof makeLive>, session: SignedIn) => {
  if (awareness === null) return () => {}
  const bridge = awareness
  const stop: Array<() => void> = []
  const fresh = randomUUID()
  const installation = recallFile('vivid.activity.installation').pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => keepFile('vivid.activity.installation', fresh).pipe(Effect.as(fresh)),
      }),
    ),
  )
  stop.push(
    launch(
      Effect.tryPromise(() => bridge.configure(session.server, Redacted.value(session.token))).pipe(
        Effect.catch(() => Effect.logWarning('Native activity session unavailable')),
      ),
    ),
  )
  const heard = bridge.addListener('token', (value) => {
    stop.push(
      launch(
        Effect.gen(function* () {
          const event = yield* decodeToken(value)
          const id = yield* installation
          const request =
            event.kind === 'Start'
              ? ActivityRegistration.cases.Start.make({ installation: id, token: event.token })
              : ActivityRegistration.cases.Update.make({ installation: id, token: event.token })
          const result = yield* engine.run(
            Effect.gen(function* () {
              return yield* (yield* VividRpcClient).RegisterActivity(request)
            }),
          )
          if (Result.isFailure(result)) return yield* result.failure
        }).pipe(Effect.catch(() => Effect.logWarning('Live Activity registration failed'))),
      ),
    )
  })
  return () => {
    heard.remove()
    launch(
      forgetFile('vivid.activity.installation').pipe(
        Effect.catch(() => Effect.logWarning('Activity installation could not be cleared')),
      ),
    )
    stop.forEach((cancel) => cancel())
    launch(
      Effect.tryPromise(() => bridge.clear()).pipe(
        Effect.catch(() => Effect.logWarning('Native activity session could not be cleared')),
      ),
    )
  }
}
