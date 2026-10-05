import { Effect, Exit, Schedule, Scope, Semaphore } from 'effect'
import { type Identity, type Link, type LinkFailure, LinkUnreachable, openLink } from './link.ts'

/** Where a machine is now and which key it presents, as its provider reports them. */
export interface LinkTarget {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly hostKey: string
}

/**
 * The open connections, one per machine, for whoever holds machines (`boat.ts`).
 *
 * A connection is opened the first time a machine is used and reused after that. `locate` is
 * asked before every opening and never between: a machine's address and host key change when it
 * resumes, so they are facts about one connection, not about the machine. `drop` closes a
 * machine's connection (it stopped, or a call found the connection gone); the next use opens a
 * new one from a fresh `locate`.
 *
 * A machine that has just been woken refuses SSH for a while (its provider refuses commands for
 * 20 to 40 seconds). Opening therefore tries again every two seconds while the machine cannot be
 * reached, for at most 75 seconds. A wrong host key or a refused key is not retried: waiting does
 * not change either.
 */
export const links = <Key>(identity: Identity) => {
  const open = new Map<Key, { readonly link: Link; readonly scope: Scope.Closeable }>()
  // One opening at a time: two first uses of one machine must not make two connections, and
  // openings are rare enough that different machines can wait for each other.
  const opening = Semaphore.makeUnsafe(1)
  const drop = (key: Key) =>
    Effect.suspend(() => {
      const found = open.get(key)
      if (found === undefined) return Effect.void
      open.delete(key)
      return Scope.close(found.scope, Exit.void)
    })
  const dial = Effect.fn('Links.dial')(function* <Failure>(
    key: Key,
    locate: Effect.Effect<LinkTarget, Failure>,
  ) {
    const target = yield* locate
    const scope = yield* Scope.make()
    const link = yield* openLink({ ...target, identity }).pipe(
      Scope.provide(scope),
      Effect.retry({
        while: (failure: LinkFailure) => failure._tag === 'LinkUnreachable',
        schedule: Schedule.spaced('2 seconds'),
        times: 30,
      }),
      // Each try may itself wait fifteen seconds for a host that does not answer, so the tries
      // are bounded by the clock as well: the caller hears "unreachable", never a hang.
      Effect.timeoutOrElse({
        duration: '75 seconds',
        orElse: () => Effect.fail(new LinkUnreachable()),
      }),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    )
    open.set(key, { link, scope })
    return link
  })
  /** `locate` is run only when a connection has to be opened. */
  const get = <Failure>(
    key: Key,
    locate: Effect.Effect<LinkTarget, Failure>,
  ): Effect.Effect<Link, Failure | LinkFailure> =>
    opening.withPermit(
      Effect.suspend(() => {
        const found = open.get(key)
        return found === undefined ? dial(key, locate) : Effect.succeed(found.link)
      }),
    )
  return { get, drop }
}
