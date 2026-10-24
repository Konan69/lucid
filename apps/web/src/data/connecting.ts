import { useAtomValue } from '@effect/atom-react'
import { ConnectionStep, type Connection } from '@vivid/contracts'
import { connecting, signInPage } from '@vivid/state'
import { Effect, Equal, Layer, Option, Result, Stream } from 'effect'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { changing, start } from './app'
import { live } from './live'
import { engine } from './runtime'

/**
 * Connecting an Integration on the web: the one machine every screen presses and draws from
 * (`connecting` in `@vivid/state`), with the four things only a browser page can do for it.
 *
 * Settings and the card in a Thread each kept an attempt in their own `useState`, set after an
 * `await`, so a late answer could write over a newer press and two attempts could run at once.
 * The attempt now stands in the machine, which lives in the registry the live data uses for as
 * long as the page does. A screen reads where it stands (`useAttempt` and the readings below)
 * and presses through `press`; nothing here is kept by a component.
 */

/**
 * The tab a click opened for a sign-in that is expected, until the server's answer says whether
 * one is needed.
 *
 * A browser only lets a page open a tab while it is handling a click, and the server is asked
 * after the click. So the click opens an empty tab, the answer either sends it to the provider's
 * page or closes it, and it is held here in between. One attempt runs at a time, so one tab is
 * enough; it is never left open once an attempt has ended without a sign-in.
 */
let held: Option.Option<Window> = Option.none()

/** Closes the tab that was held, when one was: nothing is coming to show in it. */
const release = () => {
  if (Option.isSome(held)) held.value.close()
  held = Option.none()
}

/**
 * Hands over the tab that was held, for the provider's page to be shown in. A tab the Person
 * closed while the server was being asked is not one any more, and is not handed over.
 */
const taken = () => {
  const tab = Option.filter(held, (open) => !open.closed)
  held = Option.none()
  return tab
}

/**
 * Sends a tab to a provider's sign-in page, and says whether there was a page to send it to. An
 * address that is not a page leaves nothing to show, so the tab is closed.
 */
const showSignIn = (tab: Window, address: string) => {
  const page = signInPage(address)
  if (Option.isNone(page)) {
    tab.close()
    return false
  }
  // The provider's page must not be able to reach back into this one.
  tab.opener = null
  tab.location.replace(page.value.href)
  return true
}

/**
 * Asks the server what an account needs next, from the web. Whatever the answer, a tab held for
 * a sign-in is closed unless the answer is a sign-in page: a key, an account that is already
 * connected, a refusal and a question that was dropped all leave nothing to show in it.
 */
const asking = Layer.succeed(connecting.Asking, {
  ask: (asked) =>
    Effect.gen(function* () {
      const answer = yield* changing((client) =>
        connecting.Asked.match(asked, {
          Begin: ({ service, shared, name }) =>
            client.BeginConnection({ service, name: Option.getOrNull(name), shared, from: 'Web' }),
          Resume: ({ id }) => client.ResumeConnection({ id, from: 'Web' }),
        }),
      )
      if (Result.isFailure(answer)) {
        release()
        return yield* new connecting.AskRefused()
      }
      if (!ConnectionStep.guards.OpenSignIn(answer.success)) release()
      return answer.success
    }).pipe(Effect.onInterrupt(() => Effect.sync(release))),
})

/**
 * Shows a provider's page in its own tab; this page hears that the sign-in finished through the
 * live list of Integrations (`arrivals`) and needs nothing back from that tab.
 *
 * The tab is the one the click opened. When the click did not know a sign-in was coming (an
 * account being picked up does not say what it wants until it is asked), one is opened here,
 * which a browser still allows for a few seconds after the click. When it has stopped allowing
 * it, that is `Blocked`, and the screen says to allow pop-ups.
 */
const signInTab = Layer.succeed(connecting.SignInPage, {
  open: ({ address }) =>
    Effect.suspend(() => {
      const tab = Option.orElse(taken(), () =>
        Option.fromNullOr(window.open('about:blank', '_blank')),
      )
      if (Option.isNone(tab)) return Effect.fail(new connecting.PageRefused({ reason: 'Blocked' }))
      return showSignIn(tab.value, address)
        ? Effect.void
        : Effect.fail(new connecting.PageRefused({ reason: 'Unopened' }))
    }),
})

/** The web draws its key dialog from the `Keying` state, so there is nothing to bring up. */
const keyForm = Layer.succeed(connecting.KeyForm, { show: () => Effect.void })

/**
 * Hears an account in the live list of Integrations: the provider's tab finishes beside this
 * page, and the list is what says so. The account is said as the list shows it now and then each
 * time the list moves, however it stands; the machine alone decides what is usable.
 *
 * A usable reading of this account while the Person is away is this sign-in finishing, never an
 * older state of it: an account is only picked up when the list shows it unfinished (that is
 * when the screens offer it), and a new account did not exist before. What the list shows now is
 * said too, not only its changes, because a sign-in can finish while the server is still being
 * asked or the page is still opening, before `Away` begins listening; that reading is then the
 * completion, and without it this page would wait in `Away` for good (it never says `Returned`).
 */
const arrivals = Layer.succeed(connecting.Arrivals, {
  of: (id) =>
    AtomRegistry.toStream(engine.registry, live.connections.atom).pipe(
      Stream.flatMap((result) =>
        Stream.fromIterable(
          AsyncResult.isSuccess(result)
            ? result.value.connections.filter((connection) => connection.id === id)
            : [],
        ),
      ),
    ),
})

/** How many attempts this page has begun: each press is named by the next number. */
let begun = 0

/** Names the attempt a press begins. One counter for the page, so no two attempts share a name. */
const nextAttempt = () => {
  begun += 1
  return connecting.AttemptId.make(`attempt-${begun}`)
}

/** The page's one machine. */
const machine = connecting.makeConnecting(Layer.mergeAll(asking, signInTab, keyForm, arrivals))

/**
 * Where the attempt stands, for a screen to draw from; none until the machine has started (or if
 * it ever stopped), when nothing can be pressed and nothing is said.
 */
export type Attempt = Option.Option<connecting.ConnectingState>

const attempt = Atom.map(machine.snapshot, (result): Attempt =>
  AsyncResult.isSuccess(result) && result.value.status === 'active'
    ? Option.some(result.value.state)
    : Option.none(),
)

/**
 * The card of a press this page has made and the machine has not yet shown, when there is one.
 *
 * Idle sends now publish their snapshot before returning. The reservation still covers browser
 * work before the send: the click must open its tab before the server is asked, and a reentrant
 * press must not replace that tab or its carry-on. The next snapshot releases the reservation.
 */
let unshown: Option.Option<{ readonly card: Option.Option<string> }> = Option.none()

/** What each card that pressed is owed when its attempt ends in an account: its "carry on". */
const owed = new Map<string, (connection: Connection) => void>()

// Held for as long as the page: an attempt outlives the screen that pressed it (Settings is
// closed while the Person is at the provider's page), and so does what it has to say. Each time
// the machine moves, what cards are owed is pruned: a card whose attempt is no longer the
// machine's (refused and pressed over, dismissed, replaced by another press) is owed nothing,
// and its callback used to stay for the life of the page. The card of a press not yet shown is
// kept: the machine has not got to it. Then the press that was waited on has been answered.
engine.registry.subscribe(attempt, (now) => {
  const kept = Option.flatMap(unshown, (made) => made.card)
  // Whether the machine's attempt is this card's: any standing but `Still` is.
  const holds = (card: string) =>
    Option.exists(
      now,
      (state) => !connecting.Standing.guards.Still(connecting.standingOfCard(state, card)),
    )
  for (const card of owed.keys()) {
    if (!holds(card) && !Option.exists(kept, (spared) => spared === card)) owed.delete(card)
  }
  unshown = Option.none()
})

/** Where the attempt stands. The component re-renders when the machine moves, and only then. */
export const useAttempt = (): Attempt => useAtomValue(attempt)

const still = connecting.Standing.cases.Still.make({})

/** Where the attempt made on a tile or a row stands, by the service or account it was made on. */
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

/**
 * The key the attempt is waiting for, for whoever made it to ask for: a card by the tool call it
 * stands for, Settings with none. The machine is one for the page, and Settings can be open over
 * a Thread, so each draws the dialog only for its own attempt; otherwise there would be two.
 */
export const keyingFor = (now: Attempt, card: Option.Option<string>) =>
  Option.filter(
    Option.flatMap(now, (state) => connecting.ConnectingStates.get(state, 'Keying')),
    (keying) => Equal.equals(keying.attempt.card, card),
  )

// The machine says each account it connects once, with the card that is still owed its carry-on.
// It is heard here, for the life of the page, and not by the card: a card is drawn again and
// again and may be gone by the time the sign-in finishes, and a Thread is carried on only for a
// Person who pressed, never for one who is reading the card tomorrow. Ten minutes after the press
// the machine names no card (the attempt's own deadline), so there is no timer here.
start(
  Stream.runForEach(connecting.connectedBy(machine), ({ card, connection }) =>
    Effect.sync(() => {
      if (Option.isNone(card)) return
      const carryOn = owed.get(card.value)
      if (carryOn === undefined) return
      owed.delete(card.value)
      carryOn(connection)
    }),
  ).pipe(
    Effect.provideService(AtomRegistry.AtomRegistry, engine.registry),
    // The stream ends this way only when the machine could not be started. Then there is no
    // attempt to hear of, and the screens already say so: `attempt` is none for the same
    // reason, and nothing can be pressed.
    Effect.ignore,
  ),
)

/** The Person carried a card's Thread on by hand: it is no longer owed that by its attempt. */
export const carriedOn = (card: string) => {
  owed.delete(card)
}

/** One press on something that begins or picks up an account. */
export interface Pressing {
  /** What was pressed: the service an account is added on, or the account being picked up. */
  readonly pressed: connecting.Pressed
  readonly asked: connecting.Asked
  /**
   * Whether a sign-in is known to be coming, so that its tab is opened by the click. A tab the
   * answer turns out not to need is closed again.
   */
  readonly signIn: boolean
  /**
   * The card in a Thread whose press this is, by the tool call it stands for, with what carries
   * its Thread on once the account is connected. None for a press in Settings.
   */
  readonly card: Option.Option<{
    readonly id: string
    readonly carryOn: (connection: Connection) => void
  }>
}

/**
 * Makes one press, from inside the click that made it.
 *
 * A press the machine would not take does nothing here either, so no tab is opened for it. The
 * machine refuses it as well; this check is what keeps an empty tab from being left behind. A
 * press made before the machine has shown the last one is not taken either (`unshown`). A tab
 * still held from a press the machine has not answered for is closed before another is opened,
 * so there is never more than one.
 *
 * The press names its attempt and says its moment: the machine reads no clock when it decides.
 */
export function press({ pressed, asked, signIn, card }: Pressing) {
  if (waitingOn(engine.registry.get(attempt)) || Option.isSome(unshown)) return
  unshown = Option.some({ card: Option.map(card, ({ id }) => id) })
  release()
  if (signIn) held = Option.fromNullOr(window.open('about:blank', '_blank'))
  if (Option.isSome(card)) owed.set(card.value.id, card.value.carryOn)
  engine.registry.set(
    machine.send,
    connecting.ConnectingEvents.Press({
      attempt: nextAttempt(),
      pressed,
      card: Option.map(card, ({ id }) => id),
      asked,
      at: Date.now(),
    }),
  )
}

/**
 * The Person closed the key dialog of this attempt without giving a key: the attempt is over.
 * The machine declines it for any attempt but the one it holds.
 */
export const dismiss = (of: connecting.AttemptId) => {
  engine.registry.set(machine.send, connecting.ConnectingEvents.Dismissed({ attempt: of }))
}

/**
 * The key dialog's own call was answered with this account, for this attempt, now. It is said
 * for every answer that holds an account: the machine decides whether it can be used.
 */
export const finish = (of: connecting.AttemptId, connection: Connection) => {
  engine.registry.set(
    machine.send,
    connecting.ConnectingEvents.Finished({ attempt: of, connection, at: Date.now() }),
  )
}
