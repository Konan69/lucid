import { awareness } from './awareness'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  ActivityRegistration,
  ActivityToken,
  type ActivitySnapshot,
  type Thread,
  type ThreadListResponse,
} from '@vivid/contracts'
import type { LiveQuery, makeLive } from '@vivid/state'
import { nativeThemes } from '@vivid/tokens/native'
import { Effect, Option, Redacted, Result, Schema } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { randomUUID } from 'expo-crypto'
import { launch } from './app'
import { familyAtom } from './appearance'
import { door } from './door'
import type { SignedIn } from './session'
import { keepFile, recallFile, forgetFile } from './storage'
import { facePaintOf, vividAtom } from './vivid'

/**
 * Old binaries also report push-to-start addresses (`Start`); the server no longer starts cards,
 * so only a card's own update address is registered.
 */
const TokenEvent = Schema.Struct({
  kind: Schema.Literals(['Start', 'Update']),
  token: ActivityToken,
})

const decodeToken = Schema.decodeEffect(TokenEvent)

/**
 * The first content of a card the app starts. The server replaces it as soon as the card's token
 * reaches it (registration replays the current content), so it only has to be true for a moment:
 * the Threads the live list says Vivid is working in.
 */
const firstContent = (working: ReadonlyArray<Thread>): ActivitySnapshot => ({
  rows: working.slice(0, 3).map((thread) => ({
    thread: thread.id,
    title: thread.title,
    phase: 'Working',
    line: null,
  })),
  activeCount: working.length,
  updatedAt: Date.now(),
  approval: null,
})

/**
 * Vivid's face as this phone draws it now. The card sits on the Lock Screen's dark material, so the
 * theme family's dark palette gives the accent a face in the accent colour is drawn with.
 */
const faceNow = () => {
  const appearance = door.get(vividAtom)
  const paint = facePaintOf(appearance.look, nativeThemes[door.get(familyAtom)].dark)
  return { fill: paint.fill, eyes: paint.eyes, outline: appearance.outline }
}

/** Asks the native side for the card; a binary without `arm` answers that it started none. */
const armCard = (bridge: NonNullable<typeof awareness>, arming: string) =>
  bridge.arm === undefined ? Promise.resolve(false) : bridge.arm(arming)

/**
 * Native ActivityKit owns the card and its buttons. JavaScript starts the one card when the live
 * Thread list shows Vivid working, and binds that card's rotating update address to the server.
 *
 * The app starts the card itself, in the foreground, because only then does its token come back
 * reliably; this is T3 Code's arm-on-send and prime-on-foreground
 * (`remoteRegistration.ts` `armAgentAwarenessLiveActivityForLocalWork`,
 * `refreshActiveLiveActivityRemoteRegistration`) driven by one live query instead of two calls.
 * `arm` is idempotent and ends extra cards, so calling it on every change is safe.
 */
export const followActivities = (
  engine: ReturnType<typeof makeLive>,
  session: SignedIn,
  threads: LiveQuery<ThreadListResponse>,
) => {
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
          if (event.kind !== 'Update') return
          const request = ActivityRegistration.make({
            installation: yield* installation,
            token: event.token,
          })
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
  // A binary from before the app started its own card has no `arm`; it simply shows none.
  const stopArming =
    bridge.arm === undefined
      ? () => {}
      : engine.registry.subscribe(threads.atom, (result) => {
          if (!AsyncResult.isSuccess(result)) return
          const working = result.value.threads.filter(
            (thread) => !thread.archived && thread.attention === 'Working',
          )
          if (working.length === 0) return
          const arming = JSON.stringify({ face: faceNow(), state: firstContent(working) })
          launch(
            Effect.tryPromise(() => armCard(bridge, arming)).pipe(
              // Reported, then let go: a phone that refuses a card (Live Activities off,
              // too many cards) must not stop the app, and the next change tries again.
              Effect.withErrorReporting,
              Effect.ignore,
            ),
          )
        })
  return () => {
    stopArming()
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
