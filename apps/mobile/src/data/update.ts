import { Effect, Option, Schema } from 'effect'

/**
 * Keeping the installed app on the newest JavaScript its Vivid serves.
 *
 * The native update client already asks at every cold start (`updates.checkAutomatically` in
 * `app.config.ts`) and runs what it downloaded at the cold start after. A phone rarely cold-starts
 * an app, so that alone leaves a Person days behind. This asks again from JavaScript and restarts
 * into a downloaded update at the next moment nobody is looking.
 *
 * Ported from `apps/mobile/src/features/updates/app-updates.ts` in the T3 Code fork
 * (`runAppUpdateCheck`, `armDeferredAppUpdateInstall`, `createAppUpdateForegroundRecheck`): ask at
 * launch and after a long absence, download, then restart when the app is next backgrounded,
 * because restarting under mounted native views is the moment expo-updates is most likely to
 * crash and a backgrounded restart is invisible. What is left out, and why:
 * - Flushing drafts before the restart. Vivid's drafts are written as they are typed
 *   (`drafts.ts`), so there is nothing held only in memory.
 * - The "install now?" alert after thirty minutes in the foreground, and the hidden manual check.
 *   An update that waits still lands at the next backgrounding or cold start; neither is worth an
 *   interruption or a hidden control.
 * - Rollback directives. This server never sends one (`apps/server/src/updates/release.ts`).
 */

/** A step of an update that did not happen: no network, no server, or the native client refused. */
export class UpdateStepFailed extends Schema.TaggedError<UpdateStepFailed>()(
  'UpdateStepFailed',
  { step: Schema.Literals(['download', 'restart']) },
  { title: 'Update step failed' },
) {}

/** What keeping current needs from the device, so the decisions below run without one. */
export interface UpdateClient {
  /** Asks the server and downloads what it offers. True when a newer update is now on the phone. */
  readonly download: Effect.Effect<boolean, UpdateStepFailed>
  /** Restarts the JavaScript into the downloaded update. */
  readonly restart: Effect.Effect<void, UpdateStepFailed>
  /** Whether the Person has really left the app, as opposed to a picker covering it. */
  readonly away: () => boolean
}

/**
 * The reference's `FOREGROUND_APP_UPDATE_RECHECK_AFTER_MS`. An app can stay in memory for days, so
 * a launch-only check misses what was deployed meanwhile; anything shorter turns every glance at
 * another app into a network call.
 */
export const LOOK_AGAIN_AFTER_MS = 15 * 60 * 1000

/**
 * The three moments that matter, for whoever hears the phone's app state. `idle` has nothing
 * downloaded, `looking` is asking or downloading, `ready` holds an update waiting for the Person
 * to leave, and `restarting` has asked for the restart and must not ask twice: the native restart
 * is queued, so a second request tears the app down again after it comes back (the reference's
 * `installInProgress`).
 */
export const keepCurrent = (client: UpdateClient) => {
  let phase: 'idle' | 'looking' | 'ready' | 'restarting' = 'idle'
  let leftAt = Option.none<number>()

  /**
   * Restarts into the downloaded update if the Person is away. A restart that fails gives up the
   * wait instead of retrying on every backgrounding: the downloaded update still starts at the
   * next cold start, and a later check can arm it again.
   */
  const restart = Effect.fn('Update.restart')(function* () {
    if (phase !== 'ready' || !client.away()) return
    phase = 'restarting'
    yield* client.restart.pipe(
      Effect.catchTag('UpdateStepFailed', () =>
        Effect.sync(() => {
          phase = 'idle'
        }),
      ),
    )
  })

  /**
   * A check that fails changes nothing: the app keeps what it runs and the next check asks again.
   * A download can finish after the Person has already left, with no further backgrounding to
   * ride on, so it restarts at once in that case (the reference's `includeCurrent`).
   */
  const look = Effect.fn('Update.look')(function* () {
    if (phase !== 'idle') return
    phase = 'looking'
    const downloaded = yield* client.download.pipe(
      Effect.catchTag('UpdateStepFailed', () => Effect.succeed(false)),
    )
    phase = downloaded ? 'ready' : 'idle'
    yield* restart()
  })

  const left = Effect.fn('Update.left')(function* (now: number) {
    leftAt = Option.some(now)
    yield* restart()
  })

  const returned = Effect.fn('Update.returned')(function* (now: number) {
    const longAway = Option.exists(leftAt, (at) => now - at >= LOOK_AGAIN_AFTER_MS)
    leftAt = Option.none()
    if (longAway) yield* look()
  })

  return { look, left, returned }
}
