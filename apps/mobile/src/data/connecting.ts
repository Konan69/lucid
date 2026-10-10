import { type Connection, type ConnectionId, type SignInSurface } from '@vivid/contracts'
import { connecting, signInPage, type LiveResult, type makeLive } from '@vivid/state'
import { Effect, Layer, Option, Result, Stream } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { Linking } from 'react-native'
import { launch } from './app'

/**
 * Connecting an Integration on the phone: the one machine every screen presses and draws from
 * (`connecting` in `@vivid/state`), with the four things only a phone can do for it.
 *
 * The Integrations page and the card in a Thread each kept an attempt in `useState`, set after an
 * `await` (`screen/integration/flow.ts` `press` and `returned`, `Card.tsx` `SignIn`), so a late
 * answer could write over a newer press: a return check that answered after another row was
 * pressed replaced that row's key form. The attempt now stands in the machine, and a screen reads
 * where it stands and presses through what `makeConnecting` hands back.
 *
 * It is the web's adapter (`apps/web/src/data/connecting.ts`) with the phone's differences:
 *
 * - The web's page belongs to one session, so its machine is the module's. An app outlives its
 *   sessions, and the phone builds its whole live layer per session (`makeLiveData`, `live.ts`),
 *   so the machine is made there, on that session's registry and socket, handed down as
 *   `LiveData.connecting`, and stopped when the session is disposed.
 * - There is no tab to open ahead of the answer and so nothing to be blocked: the provider's page
 *   is handed to the system's browser once the server has said where it is.
 * - The key form is a route on the stack. The navigator is only reachable from inside the shell,
 *   so the shell hands over the way to open it (`keyRoute`) and the machine's `KeyForm` calls it.
 * - The app leaves the front for the provider's page, so coming back is said to the machine
 *   (`returned`), which takes it only while a sign-in is away.
 */

/**
 * Where every sign-in trip in this app is made from. The server is told with the call that asks
 * for the provider's page (`BeginConnection`, `ResumeConnection`), and when the provider is done
 * it sends the browser back to the app on the app's own link instead of to the web's Integrations
 * page, which is where a trip made on the phone used to end (the owner, 7 October 2026). Coming
 * back to the front is what the app listens for; the link itself carries nothing the app reads.
 */
export const HERE: SignInSurface = 'Phone'

/**
 * What the `Key` route is opened with: the attempt the form belongs to (its answer and its
 * closing say it back to the machine), the account, the service's name, and the fields it asks
 * for.
 */
export interface KeyRoute {
  readonly attempt: connecting.AttemptId
  readonly id: ConnectionId
  readonly name: string
  readonly fields: connecting.KeyAsked['fields']
}

/**
 * Opens the form for a service that takes a key (the `Key` route), and answers whether it could.
 * The shell hands it over, because the machine is held outside the navigator, which is what lets
 * a card, a page and a sheet share it.
 */
export type ShowKey = (asked: KeyRoute) => boolean

/** What a card is owed when its attempt ends in an account: its Thread is carried on. */
export type CarryOn = (connection: Connection) => void

/**
 * Where the attempt stands, for a screen to draw from; none until the machine has started (or if
 * it ever stopped), when nothing can be pressed and nothing is said.
 */
export type Attempt = Option.Option<connecting.ConnectingState>

const still = connecting.Standing.cases.Still.make({})

/** Where the attempt made on a row stands, by the service or account it was made on. */
export const standingFor = (now: Attempt, pressed: connecting.Pressed): connecting.Standing =>
  Option.match(now, {
    onNone: () => still,
    onSome: (state) => connecting.standingOf(state, pressed),
  })

/** Where the attempt made on a card in a Thread stands, by the tool call the card stands for. */
export const standingForCard = (now: Attempt, card: string): connecting.Standing =>
  Option.match(now, {
    onNone: () => still,
    onSome: (state) => connecting.standingOfCard(state, card),
  })

/**
 * Whether nothing can be pressed: the server is being waited on, or there is no machine to take
 * a press. Every button that begins or picks up an account is disabled by this.
 */
export const waitingOn = (now: Attempt): boolean =>
  Option.match(now, { onNone: () => true, onSome: connecting.isWaiting })

/** Why the attempt ended without an account, when that is where it stands. */
export const refusalOf = (now: Attempt): Option.Option<connecting.Refusal> =>
  Option.map(
    Option.flatMap(now, (state) => connecting.ConnectingStates.get(state, 'Refused')),
    (refused) => refused.refusal,
  )

/** One press on something that begins or picks up an account. */
export interface Pressing {
  /** What was pressed: the service an account is added on, or the account being picked up. */
  readonly pressed: connecting.Pressed
  readonly asked: connecting.Asked
  /** The card in a Thread whose press this is, by the tool call it stands for. */
  readonly card: Option.Option<string>
}

/** What of a session's live layer the machine is built on. */
interface Session {
  /** The session's engine: its registry is where the machine lives, its socket how it asks. */
  readonly engine: Pick<ReturnType<typeof makeLive>, 'registry' | 'change'>
  /** The session's live list of Integrations, which is what says an account has connected. */
  readonly connections: Atom.Atom<LiveResult<{ readonly connections: ReadonlyArray<Connection> }>>
}

/**
 * The three services that reach outside the app for the machine: the server, the system's
 * browser, and the live list. The fourth, the key form, needs the machine itself and is made
 * with it (`makeConnecting`).
 */
function reaching({ engine, connections }: Session) {
  /**
   * Asks the server what an account needs next, from the phone, on the session's socket. A
   * refusal and a server that could not be reached are the same to the machine: nothing was begun.
   */
  const asking = Layer.succeed(connecting.Asking, {
    ask: (asked) =>
      Effect.gen(function* () {
        const answer = yield* engine.change((client) =>
          connecting.Asked.match(asked, {
            Begin: ({ service, shared, name }) =>
              client.BeginConnection({ service, name: Option.getOrNull(name), shared, from: HERE }),
            Resume: ({ id }) => client.ResumeConnection({ id, from: HERE }),
          }),
        )
        if (Result.isFailure(answer)) return yield* new connecting.AskRefused()
        return answer.success
      }),
  })

  /**
   * Hands the provider's page to the phone's browser. The app has no browser of its own (it signs
   * a device in the same way), so the page goes to the system and the app goes to the background.
   *
   * The address is only ever opened when it is a web page (`signInPage`): handed to a phone as it
   * came, another app's scheme would open that app. An address that is not a page and a system
   * that would not open it are both `Unopened`; a phone has no pop-ups, so nothing is `Blocked`.
   */
  const signIn = Layer.succeed(connecting.SignInPage, {
    open: ({ address }) =>
      Option.match(signInPage(address), {
        onNone: () => Effect.fail(new connecting.PageRefused({ reason: 'Unopened' })),
        onSome: (page) =>
          Effect.tryPromise({
            try: () => Linking.openURL(page.href),
            catch: () => new connecting.PageRefused({ reason: 'Unopened' }),
          }).pipe(Effect.asVoid),
      }),
  })

  /**
   * Hears an account in the live list of Integrations, so a sign-in finished while the Person
   * is still at the provider's page (or on another device) ends the attempt before they come
   * back. The account is said as the list shows it now and then each time the list moves,
   * however it stands; the machine alone decides what is usable.
   *
   * A usable reading of this account while the Person is away is this sign-in finishing, never
   * an older state of it: an account is only picked up when the list shows it unfinished (that
   * is when the screens offer it), and a new account did not exist before. What the list shows
   * now is said too, not only its changes, because a sign-in can finish while the server is
   * still being asked or the page is still opening, before `Away` begins listening; that reading
   * is then the completion.
   */
  const arrivals = Layer.succeed(connecting.Arrivals, {
    of: (id) =>
      AtomRegistry.toStream(engine.registry, connections).pipe(
        Stream.flatMap((result) =>
          Stream.fromIterable(
            AsyncResult.isSuccess(result)
              ? result.value.connections.filter((connection) => connection.id === id)
              : [],
          ),
        ),
      ),
  })

  return Layer.mergeAll(asking, signIn, arrivals)
}

/**
 * What cards in Threads are owed when their attempts end in an account: each one's "carry on".
 *
 * A card leaves what it is owed as it presses, or as it opens the form that names the account
 * and then presses for it: only the card holds what carries its Thread on, and a route cannot
 * carry a function. Leaving it sets nothing off. It is paid only when the machine says an
 * account connected and names this card, and the machine names a card only for an attempt whose
 * own press carried it. So a name form that is dismissed leaves nothing another press can set
 * off: a press from the Integrations page, or from another card, never names this one.
 *
 * What a card is owed is dropped once an attempt that carried it is no longer the machine's
 * (`prune`): refused and pressed over, dismissed, replaced by another press. Such entries used
 * to stay for the life of the session. One left for a name form has been carried by no press
 * yet, so it is kept until one carries it; a form that is dismissed leaves that one entry, which
 * the card's next press replaces.
 */
function owing() {
  const owed = new Map<string, CarryOn>()
  /** The cards a press has carried since they last left what they are owed. */
  const carried = new Set<string>()
  return {
    /** A card has one carry-on; leaving it again replaces it. */
    owe: (card: string, carryOn: CarryOn) => {
      owed.set(card, carryOn)
    },
    /** A press carrying this card was made. */
    carry: (card: string) => {
      carried.add(card)
    },
    /** The card is owed nothing more: it was paid, or the Person carried on by hand. */
    settle: (card: string) => {
      owed.delete(card)
      carried.delete(card)
    },
    /** An attempt ended in an account and named this card: its Thread is carried on, once. */
    pay: (card: string, connection: Connection) => {
      const carryOn = owed.get(card)
      owed.delete(card)
      carried.delete(card)
      if (carryOn !== undefined) carryOn(connection)
    },
    /**
     * The machine moved. Every card a press carried whose attempt is not the machine's any more
     * is owed nothing, except `kept`: the card of a press the machine has not shown yet.
     */
    prune: (now: Attempt, kept: Option.Option<string>) => {
      for (const card of carried) {
        const holds = !connecting.Standing.guards.Still(standingForCard(now, card))
        if (holds || Option.exists(kept, (held) => held === card)) continue
        owed.delete(card)
        carried.delete(card)
      }
    },
    clear: () => {
      owed.clear()
      carried.clear()
    },
  }
}

/**
 * Builds a session's machine, and what the screens press and draw it with.
 *
 * Everything here is the session's: the machine and its atoms live in the session's registry and
 * end with it, and what cards are owed is forgotten with them, so nothing one Person began is
 * heard by the next.
 */
export function makeConnecting(session: Session) {
  const { registry } = session.engine

  /** The way to open the `Key` route, while a shell is mounted to hand it over. */
  let route: Option.Option<ShowKey> = Option.none()

  /**
   * Opens the `Key` route over whatever is in front. A press comes from a screen, so a shell is
   * mounted and its navigator ready; were it ever not, the machine is told (`FormRefused`) and
   * ends the attempt as refused, so the row or card that was pressed says the press did not
   * start. The machine would otherwise wait in `Keying` on a form nobody can see.
   */
  const keyForm = Layer.succeed(connecting.KeyForm, {
    show: ({ attempt: of, id, serviceName, fields }) =>
      Effect.suspend(() =>
        Option.exists(route, (open) => open({ attempt: of, id, name: serviceName, fields }))
          ? Effect.void
          : Effect.fail(new connecting.FormRefused()),
      ),
  })

  /** The session's one machine. */
  const machine = connecting.makeConnecting(Layer.merge(reaching(session), keyForm))

  const attempt = Atom.map(machine.snapshot, (result): Attempt =>
    AsyncResult.isSuccess(result) && result.value.status === 'active'
      ? Option.some(result.value.state)
      : Option.none(),
  )

  /** How many attempts this session has begun: each press is named by the next number. */
  let begun = 0

  /**
   * The card of a press made here that the machine has not yet shown, when there is one.
   *
   * The machine takes a press on its own turn, so for a moment after a press the snapshot still
   * reads as it did, and a second press in that moment would pass `waitingOn` as well, be felt,
   * and then be refused by the machine. A press is therefore accepted here, at once, and nothing
   * else is until the machine has moved.
   */
  let unshown: Option.Option<{ readonly card: Option.Option<string> }> = Option.none()

  const cards = owing()

  // Held for as long as the session: an attempt outlives the screen that pressed it (the app
  // leaves the front for the provider's page, a card scrolls away), and so does what it says.
  // Each time the machine moves, what cards are owed is pruned, and the press that was waited on
  // has then been answered.
  const unmount = registry.subscribe(attempt, (now) => {
    cards.prune(
      now,
      Option.flatMap(unshown, (press) => press.card),
    )
    unshown = Option.none()
  })

  /**
   * Closes what the machine's attempt is showing, when it stands somewhere `when` says should be
   * left. `Dismissed` names the attempt, and the machine declines it for any other.
   */
  const dismissWhen = (when: (state: connecting.ConnectingState) => boolean) => {
    const held = Option.flatMap(Option.filter(registry.get(attempt), when), connecting.attemptOf)
    if (Option.isSome(held)) {
      registry.set(machine.send, connecting.ConnectingEvents.Dismissed({ attempt: held.value }))
    }
  }

  // The machine says each account it connects once, with the card that is still owed its
  // carry-on. It is heard here, for the life of the session, and not by the card: a card is drawn
  // again and again and may be gone by the time the sign-in finishes, and a Thread is carried on
  // only for a Person who pressed, never for one who is reading the card tomorrow. Ten minutes
  // after the press the machine names no card (the attempt's own deadline), so there is no timer
  // here.
  const unhear = launch(
    Stream.runForEach(connecting.connectedBy(machine), ({ card, connection }) =>
      Effect.sync(() => {
        if (Option.isSome(card)) cards.pay(card.value, connection)
      }),
    ).pipe(
      Effect.provideService(AtomRegistry.AtomRegistry, registry),
      // The stream ends this way only when the machine could not be started. Then there is no
      // attempt to hear of, and the screens already say so: `attempt` is none for the same
      // reason, and nothing can be pressed.
      Effect.ignore,
    ),
  )

  return {
    /** Where connecting stands; read with `useAtomValue` in the session's registry. */
    attempt,

    /**
     * Makes one press, and answers whether it was made. A press the machine would not take (the
     * server is still being asked, anywhere) does nothing, and neither does one made before the
     * machine has shown the last (`unshown`); the machine refuses it as well. The press names its
     * attempt and says its moment: the machine reads no clock when it decides.
     */
    press: ({ pressed, asked, card }: Pressing): boolean => {
      if (waitingOn(registry.get(attempt)) || Option.isSome(unshown)) return false
      unshown = Option.some({ card })
      if (Option.isSome(card)) cards.carry(card.value)
      begun += 1
      registry.set(
        machine.send,
        connecting.ConnectingEvents.Press({
          attempt: connecting.AttemptId.make(`attempt-${begun}`),
          pressed,
          card,
          asked,
          at: Date.now(),
        }),
      )
      return true
    },

    /** A card leaves what it is owed by the next attempt that carries it; see `owing`. */
    owe: cards.owe,

    /** The Person carried a card's Thread on by hand: it is no longer owed that by its attempt. */
    carriedOn: cards.settle,

    /**
     * The app came back to the front. The machine takes it only while a sign-in is away, when it
     * asks the server whether the sign-in went through; so it is said on every return, and
     * nothing here has to know whether one is away.
     */
    returned: () => {
      registry.set(machine.send, connecting.ConnectingEvents.Returned())
    },

    /**
     * One opening of the key form, for the attempt that asked for it, and how its one ending is
     * said to the machine.
     *
     * The sheet ends one of two ways, and the form is what knows which: the server answered its
     * call with the account (`answered`), or the sheet went without that (`closed`: a swipe, the
     * way back, the shell going). `closed` is heard as the sheet's view leaving, which also
     * happens after `answered` has closed the sheet; an ending is said once, so that leaving
     * says nothing more. Each names the attempt the sheet was opened for, and the machine
     * declines both for any other, so a sheet left from an attempt that was replaced ends
     * nothing.
     *
     * `answered` says whether it was this sheet's ending. An answer that arrives after the sheet
     * was closed is not: the attempt is already over, and there is no sheet to close.
     */
    keySheet: (of: connecting.AttemptId) => {
      let ended = false
      return {
        answered: (connection: Connection): boolean => {
          if (ended) return false
          ended = true
          registry.set(
            machine.send,
            connecting.ConnectingEvents.Finished({ attempt: of, connection, at: Date.now() }),
          )
          return true
        },
        closed: () => {
          if (ended) return
          ended = true
          registry.set(machine.send, connecting.ConnectingEvents.Dismissed({ attempt: of }))
        },
      }
    },

    /**
     * Forgets what an attempt that has ended left said ("Connected", "Did not start", a sign-in
     * that was not finished). An attempt that is still under way keeps its words.
     */
    rest: () =>
      dismissWhen(
        (state) =>
          connecting.ConnectingStates.matches(state, 'Connected') ||
          connecting.ConnectingStates.matches(state, 'Unfinished') ||
          connecting.ConnectingStates.matches(state, 'Refused'),
      ),

    /** An account is being disconnected: "Connected", said of it by the attempt, is over. */
    forget: (id: ConnectionId) =>
      dismissWhen((state) =>
        Option.exists(
          connecting.ConnectingStates.get(state, 'Connected'),
          (connected) => connected.connection.id === id,
        ),
      ),

    /**
     * Hands over the way to open the key form, for as long as a shell is mounted: it answers
     * with what to call when the shell's view is mounted, which answers with what takes it back
     * when the view goes (the shape of a ref's cleanup, `Provider.tsx`). One shell is built for
     * each workspace, so the machine never opens a route on a navigator that is gone.
     */
    keyRoute: (show: ShowKey) => () => {
      route = Option.some(show)
      return () => {
        // A newer shell may already have handed its own over; only this one's is taken back.
        if (Option.exists(route, (held) => held === show)) route = Option.none()
      }
    },

    /** The session is being disposed: stop listening. The registry ends the machine itself. */
    stop: () => {
      unhear()
      unmount()
      cards.clear()
    },
  }
}

export type Connecting = ReturnType<typeof makeConnecting>
