import { Data, Duration, Effect, Option, Redacted, Result, Schema, Semaphore } from 'effect'
import { parseServer, type ServerAddress } from './server'

/**
 * A device's session with a Vivid server: what one is, how it is written down, and the order in
 * which the app and the device's store are told when one is taken up or let go. Nothing here
 * touches the phone: `held.ts` binds it to the device's store and to the atoms the app reads, so
 * these rules can be read, and tested, on their own.
 */

/**
 * Where this device stands with a Vivid server.
 *
 * A browser is signed in by a cookie it never sees. A phone has no cookie: it holds a session
 * token and sends it as `authorization: Bearer …` on every call and on the live socket's
 * upgrade. The token and the server it belongs to are the whole of a session, kept in the
 * device's protected store between runs.
 *
 * - `Unset`: this device has never been told where its Vivid is. Nothing is assumed: no address
 *   is built into the app, so the first thing it asks for is the server.
 * - `SignedOut`: nobody is signed in here; `server` is where signing in will be tried.
 * - `Expired`: someone was signed in and the server stopped accepting their token (it ran out,
 *   or it was ended from another device). It is kept apart from `SignedOut` only so the sign-in
 *   screen can say what happened; it is stored the same way.
 * - `SignedIn`: every call carries `token`. It stays wrapped in `Redacted` so it cannot be
 *   printed by a log or an error on its way to the two places that send it.
 */
export type Session = Data.TaggedEnum<{
  Unset: {}
  SignedOut: { readonly server: ServerAddress }
  Expired: { readonly server: ServerAddress }
  SignedIn: { readonly server: ServerAddress; readonly token: Redacted.Redacted }
}>
export const Session = Data.taggedEnum<Session>()
export type SignedIn = Data.TaggedEnum.Value<Session, 'SignedIn'>
/** Every state in which the sign-in screen, not the app, is what the Person sees. */
export type Outside = Exclude<Session, SignedIn>
export const Outside = Data.taggedEnum<Outside>()

/**
 * A session as it is kept. An empty `token` is how "signed out" is written, which is also what
 * earlier builds of this app stored when no token had been entered, so an upgrade keeps the
 * server address a Person had already typed. An empty `url` is how "no server yet" is written.
 */
const Kept = Schema.fromJsonString(Schema.Struct({ url: Schema.String, token: Schema.String }))
const decodeKept = Schema.decodeUnknownOption(Kept)
const encodeKept = Schema.encodeOption(Kept)

/**
 * A session as the text the store holds for it. `keepsToken` is whether this store may be handed
 * the token at all: a store that any script can read is given the address alone (`held.ts`).
 * There is no text for a session that will not encode, and the store is then not written.
 */
export const writeKept = (session: Session, keepsToken: boolean): Option.Option<string> =>
  encodeKept(
    Session.$match(session, {
      Unset: () => ({ url: '', token: '' }),
      SignedOut: ({ server }) => ({ url: server, token: '' }),
      Expired: ({ server }) => ({ url: server, token: '' }),
      SignedIn: ({ server, token }) => ({
        url: server,
        token: keepsToken ? Redacted.value(token) : '',
      }),
    }),
  )

/** An address that no longer reads as a server is the same as never having been given one. */
const sessionOf = (kept: {
  readonly url: string
  readonly token: string
}): Option.Option<Session> =>
  Option.map(Result.getSuccess(parseServer(kept.url)), (server) =>
    kept.token === ''
      ? Session.SignedOut({ server })
      : Session.SignedIn({ server, token: Redacted.make(kept.token) }),
  )

/**
 * The session a store's text stands for, or a first launch's state when it holds nothing that
 * reads as one. A device's store is input like any other.
 */
export const readKept = (stored: Option.Option<string>): Session =>
  stored.pipe(
    Option.flatMap(decodeKept),
    Option.flatMap(sessionOf),
    Option.getOrElse(() => Session.Unset()),
  )

/**
 * Whether the device's store has caught up with a session that was ended.
 *
 * Ending a session takes effect in the app at once and in the store a moment later, and the store
 * can refuse (locked, full, unavailable). Until it has taken the change it still holds the token,
 * and the next launch would read it and sign the Person back in.
 *
 * - `Done`: the store holds what the app shows.
 * - `Underway`: the store is being told. Nothing has gone wrong, so nothing is said.
 * - `Refused`: the store did not take it. `session` is what it has still to be told; the sign-in
 *   screen says so and offers to try again.
 */
export type Forgetting = Data.TaggedEnum<{
  Done: {}
  Underway: { readonly session: Outside }
  Refused: { readonly session: Outside }
}>
export const Forgetting = Data.taggedEnum<Forgetting>()

/** No acknowledgement arrived for the request ending a session. Its server authority is unknown. */
export class SignOutUnanswered extends Schema.TaggedError<SignOutUnanswered>()(
  'SignOutUnanswered',
  {},
  { title: 'Sign-out unanswered' },
) {}

/**
 * Bounds one remote sign-out exchange whose server can hold a socket without an answer.
 * Source: unmeasured, retained eight-second request bound. Expiry records SignOutUnanswered
 * in the action atom; the app has already signed out and protected-store cleanup still runs.
 */
const SERVER_ANSWER = Duration.seconds(8)

/** What taking up and letting go of a session needs from the device it is done on. */
export interface Keeper<Refusal> {
  /** Puts a session in the device's store, which can refuse. */
  readonly write: (session: Session) => Effect.Effect<void, Refusal>
  /** Makes a session the one the app is showing and acting as. */
  readonly show: (session: Session) => void
  /** How the store stands with the last session that was ended. */
  readonly owed: () => Forgetting
  readonly owe: (next: Forgetting) => void
}

/**
 * Taking up and letting go of a session, on one device.
 *
 * The two go in opposite orders, and that is the point of this. Taking a session up keeps it
 * before showing it, so a session the device could not keep is never presented as signed in only
 * to vanish at the next launch. Letting one go shows it first: leaving used to go through the same
 * keep-then-show path, so a store that would not be written left the Person signed in, with every
 * screen and the live socket still acting as them and nothing on screen to say that signing out
 * had failed.
 */
export function makeCustody<Refusal>(keeper: Keeper<Refusal>) {
  // One write to the store at a time. Signing in and a retried forgetting both write the same
  // entry; taking turns is what lets each check, and then act on, what the other has just done.
  const storing = Semaphore.makeUnsafe(1)

  /**
   * Gives one change to the store its turn, and keeps the turn until the store has answered.
   *
   * The protected store speaks Promises that cannot be cancelled (`storage.ts`), and an
   * interrupted or timed-out `Effect.tryPromise` only stops listening: the write it started still
   * lands, whenever the store gets to it (`tryPromise` in effect 4.0.0-rc.116's
   * `internal/effect.ts`). A turn given back early would let the next write start, and finish,
   * before that one, which would then land on top of it: a late "signed out" over the token of a
   * Person who has since signed in. So a turn is never cut short, by an interruption or by a
   * clock. Waiting for a turn can still be interrupted; only a change already begun cannot.
   *
   * The cost is stated, not hidden: a store that never answers keeps its turn for good, and a
   * later sign-in waits behind it without ever being shown as signed in. That is the true state
   * of a device whose store has stopped answering; it is not known to have refused.
   */
  const inTurn = <A, E>(change: Effect.Effect<A, E>) =>
    storing.withPermit(Effect.uninterruptible(change))

  /**
   * Makes a session this device's own, kept before it is shown. A session that is kept replaces
   * whatever the store held, so anything the store had still to forget is forgotten with it.
   */
  const adopt = Effect.fn('Session.adopt')(function* (session: Session) {
    yield* inTurn(
      Effect.gen(function* () {
        yield* keeper.write(session)
        yield* Effect.sync(() => {
          keeper.owe(Forgetting.Done())
          keeper.show(session)
        })
      }),
    )
  })

  /**
   * One attempt to make the store catch up with a session that was ended. It reads what is owed
   * only once it holds the store, so a Person who signed in again in the meantime (which settles
   * the debt) is never signed back out by a late retry writing over their new session.
   */
  const forgetOnce = inTurn(
    Effect.gen(function* () {
      const owed = keeper.owed()
      if (Forgetting.$is('Done')(owed)) return
      yield* keeper
        .write(owed.session)
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => keeper.owe(Forgetting.Refused({ session: owed.session }))),
          ),
        )
      yield* Effect.sync(() => keeper.owe(Forgetting.Done()))
    }),
  )

  /**
   * Gives the store one attempt. StorageUnavailable does not distinguish a lock from full or
   * broken storage, so automatic retries cannot be justified. Refused retains the existing
   * manual retry while inTurn still protects an already-started write from interruption.
   */
  const forget = Effect.fn('Session.forget')(() => forgetOnce)

  /**
   * Takes the token out of the app, in this turn: every screen and the live socket stop acting as
   * the Person before anything that can wait or fail is started. What the store has still to be
   * told is put on record in the same step.
   */
  const release = (session: Outside) =>
    Effect.sync(() => {
      keeper.show(session)
      keeper.owe(Forgetting.Underway({ session }))
    })

  /**
   * Ends this device's authority: the token is out of the app first, and out of the store second.
   * Leaving must not wait on the store. The store is told afterwards, and a refusal is kept
   * (`Forgetting`) and tried again instead of being lost.
   */
  const drop = Effect.fn('Session.drop')(function* (session: Outside) {
    yield* release(session)
    yield* forget()
  })

  /**
   * Releases the app immediately, then asks the server and protected store independently.
   * Neither delays the start of the other. A refused store remains recorded as Forgetting,
   * and a refused or unanswered revocation reaches the action atom after both have settled.
   * No generic refusal is retried: replay safety alone does not make a failure transient.
   */
  const leave = Effect.fn('Session.leave')(function* <Unanswered>(
    session: Outside,
    revoke: Effect.Effect<void, Unanswered>,
  ) {
    yield* release(session)
    const [revoked] = yield* Effect.all(
      [
        Effect.result(
          revoke.pipe(
            Effect.timeoutOrElse({
              duration: SERVER_ANSWER,
              orElse: () => Effect.fail(new SignOutUnanswered({})),
            }),
          ),
        ),
        Effect.ignore(forget()),
      ],
      { concurrency: 'unbounded' },
    )
    return yield* Effect.fromResult(revoked)
  })

  return { adopt, drop, forget, leave }
}
