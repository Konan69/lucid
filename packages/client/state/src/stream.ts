/**
 * What a conversation's stream is doing, read from what Flue's hook reports about it.
 *
 * A conversation arrives over Flue's own stream, not the app's socket, and Flue's hook reports
 * every interruption of it through one `error` field: a connection it is already reopening by
 * itself, and one it has given up on. Drawn as they come, a deploy, a phone that slept or a
 * change of network each put Flue's own sentence on the screen ("Agent conversation stream
 * stalled: no activity for 90000ms.") for a fault that mends in a second. Production on
 * 13 October 2026 cut every open stream twelve times in two days, once per deploy.
 *
 * - `Flowing`: nothing is wrong.
 * - `CatchingUp`: the stream broke and Flue is opening it again (`@flue/sdk` 2.2.2 `observe`,
 *   `scheduleRetry`: phase `connecting` with the error kept, retried after 1, 2, 4 ... 30
 *   seconds). Nothing is lost: the stream resumes from where it stopped.
 * - `Cut`: Flue stopped trying (`@flue/react` 2.2.2 `local_observation`, phase `error`: a
 *   refused request or three refused sign-ins in a row), or this client's own send failed. Only
 *   opening it again by hand moves it.
 */
export type Reading = 'Flowing' | 'CatchingUp' | 'Cut'

/**
 * The stream's reading from what Flue's hook reports. The status is the one Flue's own reducer
 * sets to `error` when it has stopped; any other status beside an error is a retry in progress.
 *
 * The hook raises the same `error` and `error` status for a third thing that is not the stream's
 * at all: the last message sent from this client ended in a failed Run (`@flue/react` 2.2.2
 * `converge`, `failedSettlement`). The stream is fine then, and the Run's own ending says what
 * happened from the server's record of it, so that case reads as `Flowing`.
 */
export const readingOf = (agent: {
  readonly status: 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error'
  /** Flue's hook is holding an error, whatever it says. */
  readonly broken: boolean
  /** The newest settlement the hook holds is a failed one. */
  readonly settledBadly: boolean
}): Reading => {
  if (!agent.broken) return 'Flowing'
  if (agent.status !== 'error') return 'CatchingUp'
  return agent.settledBadly ? 'Flowing' : 'Cut'
}

/**
 * How long a stream may be catching up before a screen says so while the app's own socket is
 * open. Flue retries a failed request for ever (`scheduleRetry`: only a 400 or three refused
 * sign-ins stop it), so a conversation endpoint that stays broken would otherwise never be
 * said. Twenty seconds is past a deploy, the longest ordinary break: production's replaced
 * runtime refused streams for about ten seconds (13 October 2026, 12:08:04 to 12:08:16 UTC),
 * which Flue's retries after 1, 2, 4 and 8 seconds cover.
 */
export const QUIET_MS = 20_000

/**
 * Whether a screen says anything about the stream. A stream that is catching up is said when
 * the app's own socket is down as well, since then the server really is out of reach, or when it
 * has been catching up for longer than `QUIET_MS` (`lasting`). Before that the break is the
 * stream's alone and is usually over before a sentence could be read.
 */
export const streamSaid = (
  reading: Reading,
  at: { readonly socketLost: boolean; readonly late: boolean },
): boolean => reading === 'Cut' || (reading === 'CatchingUp' && (at.socketLost || at.late))

/**
 * Whether something has held for `ms`, as an external store a screen reads with
 * `useSyncExternalStore`: made anew each time `on` changes, it starts its one timer when it is
 * subscribed to and answers `true` once the time has passed. No effect hook and nothing set
 * during a render; a store that is let go clears its timer.
 */
export const lasting = (on: boolean, ms: number) => {
  let late = false
  return {
    subscribe: (heard: () => void) => {
      if (!on) return () => undefined
      const timer = setTimeout(() => {
        late = true
        heard()
      }, ms)
      return () => clearTimeout(timer)
    },
    read: () => late,
  }
}
