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
 * The stream's reading from the two fields of Flue's hook that carry it. The status is the one
 * Flue's own reducer sets to `error` when it has stopped; any other status beside an error is a
 * retry in progress.
 */
export const readingOf = (agent: {
  readonly status: 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error'
  /** Flue's hook is holding an error, whatever it says. */
  readonly broken: boolean
}): Reading => {
  if (!agent.broken) return 'Flowing'
  return agent.status === 'error' ? 'Cut' : 'CatchingUp'
}

/**
 * Whether a screen says anything about the stream. A stream that is catching up is said only
 * when the app's own socket is down as well: then the server really is out of reach, and saying
 * nothing would leave a conversation that looks finished and is not. With the socket open the
 * break is the stream's alone and is over before a sentence could be read.
 */
export const streamSaid = (reading: Reading, socketLost: boolean): boolean =>
  reading === 'Cut' || (reading === 'CatchingUp' && socketLost)
