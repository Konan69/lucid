import { Effect, Exit, Schedule, Scope, Semaphore } from 'effect'
import {
  type Identity,
  type Link,
  type LinkFailure,
  LinkUnreachable,
  openLink,
  pruneKeys,
} from './link.ts'

/**
 * Where a machine is now and which key it presents, as its provider reports them, with the key
 * pair this one opening was given: the provider authorized its public half on this machine when
 * it was asked where the machine is.
 */
export interface LinkTarget {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly hostKey: string
  readonly identity: Identity
}

/**
 * The open connections, one per machine, for whoever holds machines (`boat.ts`).
 *
 * A connection is opened the first time a machine is used and reused after that. No key is held
 * here: each opening is given its own pair by `locate` (`LinkTarget.identity`), so no two
 * machines, and no two openings of one machine, ever present the same key. `authorizedKeys` is
 * the machine's authorized-keys file, where the lines of ended connections are removed. `locate` is
 * asked before every opening and never between: a machine's address and host key change when it
 * resumes, so they are facts about one connection, not about the machine.
 *
 * Two things end a connection, and they are different. `forget` is the machine stopping or
 * resuming: whatever is open to it is closed and an opening under way is abandoned, because both
 * are for the machine as it was. `discard` is one call finding its own connection gone: that
 * connection is closed and no other, so a call that hears of the loss late cannot close the
 * connection another call has opened since. After either, the next use opens a new one from a
 * fresh `locate`.
 *
 * A machine that has just been woken refuses SSH for a while (its provider refuses commands for
 * 20 to 40 seconds). Opening therefore tries again every two seconds while the machine cannot be
 * reached, for at most 75 seconds. A wrong host key or a refused key is not retried: waiting does
 * not change either.
 */
export const links = <Key>(authorizedKeys: string) => {
  const open = new Map<Key, { readonly link: Link; readonly scope: Scope.Closeable }>()
  // One opening at a time for each machine: two first uses of one machine must not make two
  // connections. Machines do not wait for each other. An opening asks the provider where the
  // machine is and may wait on a machine that has just woken (seen 5 October 2026: minutes), and
  // one lock for all would hold every other machine's calls, open connection or not, for that long.
  const openings = new Map<Key, Semaphore.Semaphore>()
  const opening = (key: Key) => {
    const found = openings.get(key)
    if (found !== undefined) return found
    const made = Semaphore.makeUnsafe(1)
    openings.set(key, made)
    return made
  }
  /**
   * The opening under way for each machine, as a token only that opening holds (a symbol: two
   * openings are never the same one). `forget` and
   * `close` take it away, and an opening that no longer finds its token keeps nothing: the
   * machine stopped or resumed while it was being reached, or the owner has finished.
   */
  const pending = new Map<Key, symbol>()
  /** Set by `close`. Nothing is opened afterwards: the owner would never close it. */
  let closed = false
  /**
   * Takes a connection out of the map and closes it as one step that cannot be interrupted
   * between the two: `Scope.close` does not mask interruption itself (Effect rc.116), and a
   * connection that is out of the map and not closed is open with no owner.
   */
  const shut = (key: Key, which: (link: Link) => boolean) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        const found = open.get(key)
        if (found === undefined || !which(found.link)) return Effect.void
        open.delete(key)
        return Scope.close(found.scope, Exit.void)
      }),
    )
  const forget = (key: Key) =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        pending.delete(key)
        return shut(key, () => true)
      }),
    )
  const discard = (key: Key, link: Link) => shut(key, (held) => held === link)
  /**
   * The first act on a new connection: the key lines of this machine's earlier connections go
   * (`pruneKeys`). A prune that did not work is logged, without any key, and the connection is
   * used all the same: the caller's command does not depend on it, and the next opening prunes
   * again.
   */
  const pruned = (link: Link, identity: Identity) =>
    pruneKeys(link, identity, authorizedKeys).pipe(
      Effect.flatMap((done) =>
        done ? Effect.void : Effect.logWarning('Old SSH key lines could not be removed.'),
      ),
    )
  /**
   * One try, with a scope of its own. Learning that the connection opened and handing it to the
   * map are one uninterruptible step: a caller that gives up, or the deadline passing, at that
   * moment cannot leave a connection open that nobody owns. Only the wait for the host can be
   * interrupted, and a try that fails or is interrupted closes its own scope, so a connection that
   * authenticated and then failed is not left open while the next try makes another. A try whose
   * opening was abandoned meanwhile closes what it opened and says the machine was not reached.
   */
  const attempt = (key: Key, token: symbol, target: LinkTarget) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (pending.get(key) !== token) return yield* new LinkUnreachable()
        const scope = yield* Scope.make()
        const link = yield* restore(openLink(target).pipe(Scope.provide(scope))).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, Exit.void),
          ),
        )
        // The first act on the new connection, before anyone else can be handed it: the key
        // lines of this machine's earlier connections go. A caller that gives up meanwhile
        // closes the connection, so one that was never cleaned is never kept.
        yield* restore(pruned(link, target.identity)).pipe(
          Effect.onInterrupt(() => Scope.close(scope, Exit.void)),
        )
        // Asked after the cleaning as well: the machine may have stopped during it.
        if (pending.get(key) !== token) {
          yield* Scope.close(scope, Exit.void)
          return yield* new LinkUnreachable()
        }
        pending.delete(key)
        open.set(key, { link, scope })
        return link
      }),
    )
  /** The tries for one opening: again every two seconds while the machine cannot be reached and
   * the opening has not been abandoned, which waiting would not change. */
  const tries = (key: Key, token: symbol, target: LinkTarget) =>
    attempt(key, token, target).pipe(
      Effect.retry({
        while: (failure: LinkFailure) =>
          failure instanceof LinkUnreachable && pending.get(key) === token,
        schedule: Schedule.spaced('2 seconds'),
        times: 30,
      }),
      // Each try may itself wait fifteen seconds for a host that does not answer, so the tries
      // are bounded by the clock as well: the caller hears "unreachable", never a hang.
      Effect.timeoutOrElse({
        duration: '75 seconds',
        orElse: () => Effect.fail(new LinkUnreachable()),
      }),
    )
  /** An opening that ended without a connection leaves no token behind. */
  const settled = (key: Key, token: symbol) =>
    Effect.sync(() => {
      if (pending.get(key) === token) pending.delete(key)
    })
  /**
   * Taking the token and registering its removal are one uninterruptible step, so a caller that
   * gives up at that moment leaves no token; asking where the machine is and the tries can be
   * interrupted as before.
   */
  const dial = <Failure>(
    key: Key,
    locate: Effect.Effect<LinkTarget, Failure>,
  ): Effect.Effect<Link, Failure | LinkFailure> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        // Asked in the same step that takes the token. A check made earlier could be followed by
        // `close` and then by this opening: a connection made after the owner's last act.
        if (closed) return Effect.fail(new LinkUnreachable())
        const token = Symbol('opening')
        pending.set(key, token)
        return restore(locate.pipe(Effect.flatMap((target) => tries(key, token, target)))).pipe(
          Effect.ensuring(settled(key, token)),
        )
      }),
    )
  /** `locate` is run only when a connection has to be opened. */
  const get = <Failure>(
    key: Key,
    locate: Effect.Effect<LinkTarget, Failure>,
  ): Effect.Effect<Link, Failure | LinkFailure> =>
    opening(key).withPermit(
      Effect.gen(function* () {
        // The owner is closing or has closed: a connection still in the map is on its way out and
        // is not handed to a new caller.
        if (closed) return yield* new LinkUnreachable()
        const found = open.get(key)
        if (found === undefined) return yield* dial(key, locate)
        if (found.link.alive()) return found.link
        // A connection that closed while nobody was using it (the machine stopped, the path
        // dropped) is put away here, so a dead one is never handed out.
        yield* discard(key, found.link)
        return yield* dial(key, locate)
      }),
    )
  /** Closes every connection and abandons every opening: the owner's last act. */
  const close = Effect.uninterruptible(
    Effect.suspend(() => {
      closed = true
      pending.clear()
      return Effect.forEach([...open.keys()], forget, { discard: true })
    }),
  )
  return { get, forget, discard, close }
}
