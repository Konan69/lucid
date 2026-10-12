import { describe, expect, it } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import { MachineTest } from '@typeonce/effect-machine/testing'
import {
  ConnectionId,
  ConnectionOwnership,
  ConnectionState,
  ConnectionStep,
  PersonId,
  ServiceId,
  type Connection,
} from '@vivid/contracts'
import { Arbitrary, Effect, Layer, Option, Predicate, Queue, Result, Schema, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import {
  AskRefused,
  Asked,
  Arrivals,
  Asking,
  AttemptId,
  Connecting,
  ConnectingEvents,
  ConnectingStates,
  FormRefused,
  isWaiting,
  KeyForm,
  PageRefused,
  Refusal,
  SignInPage,
  Standing,
  attemptOf,
  standingOf,
  standingOfCard,
} from './connecting.ts'

const gmail = ServiceId.make('gmail')
const notion = ServiceId.make('notion')

/** One account as the server sends it. */
const account = (
  id: string,
  service: ServiceId,
  state: Connection['state'] = ConnectionState.cases.Ready.make({}),
): Connection => ({
  id: ConnectionId.make(id),
  service,
  serviceName: service,
  mark: null,
  name: null,
  identity: null,
  account: service,
  origin: 'Catalogue',
  ownership: ConnectionOwnership.cases.Personal.make({
    owner: { id: PersonId.make('ada'), name: 'Ada Obi', image: null },
  }),
  state,
  createdAt: 1,
})

const signIn = (connection: Connection) =>
  ConnectionStep.cases.OpenSignIn.make({ connection, address: 'https://provider.example/sign-in' })
const done = (connection: Connection) => ConnectionStep.cases.Done.make({ connection })
const key = (connection: Connection) =>
  ConnectionStep.cases.EnterKey.make({ connection, fields: [{ name: 'token', label: 'Token' }] })

const begin = (service: ServiceId) =>
  Asked.cases.Begin.make({ service, shared: false, name: Option.none() })
const first = AttemptId.make('first')
const second = AttemptId.make('second')

/** How long after its press a card is owed its carry-on, in ms: the rule, said apart from the machine. */
const OWED = 600_000
/** When the second attempt is pressed. Not the first's moment, so its deadline is its own. */
const PRESSED = 1_000

/** A press on a service, as the attempt named, at the test clock's start unless a moment is said. */
const pressOn = (
  service: ServiceId,
  said: { readonly attempt?: AttemptId; readonly card?: string; readonly at?: number } = {},
) =>
  ConnectingEvents.Press({
    attempt: said.attempt === undefined ? first : said.attempt,
    pressed: service,
    card: Option.fromUndefinedOr(said.card),
    asked: begin(service),
    at: said.at === undefined ? 0 : said.at,
  })

/**
 * A server the test answers by hand: each question takes the next answer the test hands over, in
 * order, whether the answer was handed over before the question was put or after. `asked` is
 * every question put, in order.
 */
const makeServer = Effect.fn('Connecting.test.server')(function* () {
  const asked: Array<Asked> = []
  const answers = yield* Queue.unbounded<Result.Result<ConnectionStep, AskRefused>>()
  const layer = Layer.succeed(Asking, {
    ask: (question) =>
      Effect.suspend(() => {
        asked.push(question)
        return Effect.flatMap(Queue.take(answers), Effect.fromResult)
      }),
  })
  return {
    layer,
    asked,
    answer: (step: ConnectionStep) => Queue.offer(answers, Result.succeed(step)),
    refuse: Queue.offer(answers, Result.fail(new AskRefused())),
  }
})

/** A browser that opens every page, or refuses every page the way it is told to. */
const browser = (refusal: Option.Option<PageRefused['reason']>) =>
  Layer.succeed(SignInPage, {
    open: () =>
      Option.match(refusal, {
        onNone: () => Effect.void,
        onSome: (reason) => Effect.fail(new PageRefused({ reason })),
      }),
  })

/** What a case may make go wrong: the page cannot be opened, or there is nowhere to show a key form. */
interface Faults {
  readonly page: Option.Option<PageRefused['reason']>
  readonly noForm: boolean
  /** The page says it opened only when the case says so (`open`), so a case can stand in `Opening`. */
  readonly heldPage: boolean
}
const working: Faults = { page: Option.none(), noForm: false, heldPage: false }

/** An account the machine said it connected, as a listener hears it: the card it named, and the account. */
type Heard = readonly [Option.Option<string>, Connection['id']]

/** Starts the machine against a hand-answered server and says where it stands. */
const started = ({ page, noForm, heldPage }: Faults = working) =>
  Effect.gen(function* () {
    const server = yield* makeServer()
    const opened = yield* Queue.unbounded<void>()
    const signInPage = heldPage
      ? Layer.succeed(SignInPage, { open: () => Queue.take(opened) })
      : browser(page)
    /** Every key form brought up, by the attempt it was for. */
    const forms: Array<AttemptId> = []
    const keyForm = Layer.succeed(KeyForm, {
      show: (form) =>
        noForm ? Effect.fail(new FormRefused()) : Effect.sync(() => void forms.push(form.attempt)),
    })
    /** What the live list says from now on: an account offered here is heard. */
    const arrived = yield* Queue.unbounded<Connection>()
    const arrivals = Layer.succeed(Arrivals, {
      of: (id) => Stream.fromQueue(arrived).pipe(Stream.filter((item) => item.id === id)),
    })
    const ref = yield* Machine.start(Connecting).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- Each case answers its own server by hand, so the services are built for the one machine a case starts and hold no resource.
      Effect.provide(Layer.mergeAll(server.layer, signInPage, keyForm, arrivals)),
    )
    /** Every account the machine said it connected, in order, with the card it named. */
    const said = yield* Queue.unbounded<Heard>()
    yield* Effect.forkScoped(
      Stream.runForEach(ref.emissions, (event) =>
        Queue.offer(said, [event.card, event.connection.id]),
      ),
    )
    const at = (path: Parameters<typeof ConnectingStates.matches>[1]) =>
      Machine.waitFor(ref, (snapshot) => ConnectingStates.matches(snapshot.state, path))
    // The machine's events are said through this where a case must know one was dealt with: an
    // event that is not taken publishes nothing, so no snapshot can be waited on for it.
    const probe = yield* MachineTest.probe(
      Connecting,
      // A gap in the library's types, not in this machine. `MachineTest.probe` (installed
      // `@typeonce/effect-machine` 0.40.0 `src/testing/MachineTest.ts`, `probe` and `Probe`) names
      // `Machine.MachineRef` with four arguments, so the fifth, what the machine emits, is `never`
      // (`src/Machine.ts`, `MachineRef`), and the reference of a machine that says `Connected` is
      // refused: "Connected is not assignable to never". The probe only sends through this
      // reference and waits for the acknowledgement; what the machine says is read from
      // `ref.emissions` above, with its real type. No typed way to probe an emitting machine is
      // published. Remove the directive when a release names the fifth argument: unused, it fails
      // typecheck.
      // @ts-expect-error -- `MachineTest.probe` leaves `MachineRef`'s emitted type at `never` (0.40.0); see above.
      ref,
    )
    return { server, ref, probe, at, forms, arrived, said, open: Queue.offer(opened, undefined) }
  })
type Started = Effect.Success<ReturnType<typeof started>>

const gmailAccount = account('a1', gmail)
const refusedKey = account(
  'a1',
  gmail,
  ConnectionState.cases.Failed.make({ reason: 'The key was not accepted.' }),
)

/**
 * The key form of a second attempt, open on the account the first attempt's form was open on:
 * the Person pressed the account again. The first form is still about, and can answer late.
 */
const replaced = Effect.fn('Connecting.test.replaced')(function* () {
  const made = yield* started()
  yield* made.probe.sendAndAwait(pressOn(gmail, { card: 'call-1' }))
  yield* made.server.answer(key(gmailAccount))
  yield* made.at('Keying')
  // The press is dealt with before the answer is handed over, so the form waited for is the
  // second attempt's and not the first's still standing.
  yield* made.probe.sendAndAwait(pressOn(gmail, { attempt: second, card: 'call-2', at: PRESSED }))
  yield* made.server.answer(key(gmailAccount))
  yield* made.at('Keying')
  return made
})

/**
 * Checks everything the machine said it connected, as a listener hears it, against `owed`. A
 * listener cannot be asked whether more is coming, so one more account is connected and must be
 * the very next thing heard: one saying too many, or one too few, puts something else there.
 * The machine must stand where a press is taken.
 */
const saidOnly = (made: Started, owed: ReadonlyArray<Heard>) =>
  Effect.gen(function* () {
    const last = account('n1', notion)
    yield* made.probe.sendAndAwait(pressOn(notion, { attempt: AttemptId.make('last') }))
    yield* made.server.answer(done(last))
    expect(yield* Effect.forEach(owed, () => Queue.take(made.said))).toEqual(owed)
    expect(yield* Queue.take(made.said)).toEqual([Option.none(), last.id])
  })

/**
 * What is said to the machine in a generated case: the event as the machine reads it once decoded,
 * so a rule can read it too. A generated event is written as that decoded record and not through
 * `ConnectingEvents`: the library's constructors answer an opaque `Machine.EventConstruction`
 * that shows only its `_tag` until the machine decodes it (installed `@typeonce/effect-machine`
 * 0.40.0 `src/Machine.ts`, `EventConstruction`), so a rule handed one reads no attempt, account
 * or moment and calls every saying "not taken". `MachineTest.runtimeCommands` and
 * `runCausalCommands` are typed for the decoded event for the same reason (`eventArbitrary` and
 * `commands` in `src/internal/testing/machine/runtime.ts`). The record's shape is not said again
 * here: `Said` is drawn from `Connecting`, so a field the machine's events lose or gain fails
 * typecheck. Fixed cases that inspect nothing keep the constructors.
 */
type Said = Machine.Machine.InputEvent<typeof Connecting>

const states = {
  Ready: ConnectionState.cases.Ready.make({}),
  Failed: ConnectionState.cases.Failed.make({ reason: 'The key was not accepted.' }),
  NeedsAuthorization: ConnectionState.cases.NeedsAuthorization.make({}),
}

/**
 * What a form or a note says about an attempt from outside the machine, drawn from the values a
 * rule turns on: whose it is (the replaced attempt, the one standing, one never made), which
 * account, whether the account can be used, and the moments either side of the card's deadline.
 */
const Outside = Schema.Struct({
  closes: Schema.Boolean,
  attempt: Schema.Literals(['first', 'second', 'ghost']),
  account: Schema.Literals(['a1', 'other']),
  state: Schema.Literals(['Ready', 'Failed', 'NeedsAuthorization']),
  at: Schema.Literals([PRESSED, PRESSED + OWED, PRESSED + OWED + 1]),
})
const outside = (from: typeof Outside.Type): Said =>
  from.closes
    ? {
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- The constructor's value is opaque until the machine decodes it; the rule must read this event (see `Said`).
        _tag: 'Dismissed',
        attempt: AttemptId.make(from.attempt),
      }
    : {
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- The constructor's value is opaque until the machine decodes it; the rule must read this event (see `Said`).
        _tag: 'Finished',
        attempt: AttemptId.make(from.attempt),
        connection: account(from.account, gmail, states[from.state]),
        at: from.at,
      }

/** A press made while an attempt is under way: the same attempt again, or another one. */
const Again = Schema.Struct({
  attempt: Schema.Literals(['first', 'second', 'ghost']),
  service: Schema.Literals(['gmail', 'notion']),
  at: Schema.Literals([0, OWED + 1]),
})
const again = (from: typeof Again.Type): Said => {
  const service = ServiceId.make(from.service)
  return {
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- `runtimeCommands` generates decoded events; the constructor's value is opaque (see `Said`).
    _tag: 'Press',
    attempt: AttemptId.make(from.attempt),
    pressed: service,
    card: Option.some('call-2'),
    asked: begin(service),
    at: from.at,
  }
}
/**
 * Coming back from the provider's page, as one command a causal run waits on: said behind a burst
 * that was only queued, it shows every saying before it was dealt with.
 */
const returnedBehind = MachineTest.sendCommand<Said>({
  // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- `runCausalCommands` takes decoded events; the constructor's value is opaque (see `Said`).
  _tag: 'Returned',
})

const outsideSaid = Arbitrary.schema(Outside)
const pressing = Arbitrary.schema(Again).pipe(Arbitrary.map(again))
/** Only events are generated: a case moves the clock and answers the server itself, where a rule needs it. */
const eventsOnly = { includeAdvance: false, includeStop: false, includeCheckpoint: false }
/** Up to four things said from outside an attempt, one after another. */
const outsiders = MachineTest.runtimeCommands(Connecting, {
  ...eventsOnly,
  eventArbitrary: outsideSaid.pipe(Arbitrary.map(outside)),
  maxCommands: 4,
}).arbitrary
/** Up to four presses and outside sayings, mixed: what a machine that is waiting must not take. */
const untaken = MachineTest.runtimeCommands(Connecting, {
  ...eventsOnly,
  eventArbitrary: pressing,
  additionalCommands: [
    outsideSaid.pipe(Arbitrary.map((from) => MachineTest.sendCommand(outside(from)))),
  ],
  maxCommands: 4,
}).arbitrary
/** The same cases every run; a failure prints the case it shrank to and how to replay it. */
const generated = { arbitrary: { runs: 100, seed: 20261011 } }

/**
 * The two moments a card's deadline turns on, as ms past it: at the deadline itself the card is
 * still owed its carry-on, and one millisecond later it is not. Said here as fixed cases, because
 * a generated case reaches either moment only when it happens to draw it before its attempt ends.
 */
const deadline = [
  { moment: 'at its deadline', past: 0, owed: true },
  { moment: 'one millisecond after its deadline', past: 1, owed: false },
]

/** Where the second attempt of `replaced` stands by the rule alone, and what saying got it there. */
interface Ruled {
  readonly stand: 'Keying' | 'Connected' | 'Refused' | 'Idle'
  readonly moved: boolean
  readonly says: ReadonlyArray<Heard>
}
const keyFormOpen: Ruled = { stand: 'Keying', moved: false, says: [] }

/**
 * The rule for an attempt whose key form is open, written from what the product promises and
 * not from the machine: nothing said for another attempt moves it; its own closing ends it with
 * nothing left to say; its own form's answer about its own account ends it once, connected when
 * the account can be used (naming the card while the card is still owed) and refused when not.
 */
const ruled = (was: Ruled['stand'], command: MachineTest.RuntimeCommand<Said>): Ruled => {
  const still: Ruled = { stand: was, moved: false, says: [] }
  if (!Predicate.isTagged(command, 'Send')) return still
  const said = command.event
  if (
    Predicate.isTagged(said, 'Press') ||
    Predicate.isTagged(said, 'Returned') ||
    said.attempt !== second
  ) {
    return still
  }
  if (Predicate.isTagged(said, 'Dismissed'))
    return { stand: 'Idle', moved: was !== 'Idle', says: [] }
  if (was !== 'Keying' || said.connection.id !== gmailAccount.id) return still
  if (!ConnectionState.guards.Ready(said.connection.state)) {
    return { stand: 'Refused', moved: true, says: [] }
  }
  const card = said.at <= PRESSED + OWED ? Option.some('call-2') : Option.none()
  return { stand: 'Connected', moved: true, says: [[card, said.connection.id]] }
}

describe('connecting an Integration', () => {
  it.effect('asks once for a double press, and takes no second press while asking', () =>
    Effect.gen(function* () {
      const { server, ref, at } = yield* started()
      yield* ref.send(pressOn(gmail))
      yield* ref.send(pressOn(notion, { attempt: second }))
      yield* at('Asking')
      yield* server.answer(done(gmailAccount))
      const snapshot = yield* at('Connected')
      // The second press was not taken: one question, the first press's, and its attempt stands.
      expect(server.asked).toEqual([begin(gmail)])
      expect(attemptOf(snapshot.state)).toEqual(Option.some(first))
    }),
  )

  it.effect('says an account connected once, with the card that pressed', () =>
    Effect.gen(function* () {
      const { server, ref, at, said } = yield* started()
      yield* ref.send(pressOn(gmail, { card: 'call-1' }))
      yield* at('Asking')
      yield* server.answer(done(gmailAccount))
      yield* at('Connected')
      expect(yield* Queue.take(said)).toEqual([Option.some('call-1'), gmailAccount.id])
      // Closing its words says nothing more.
      yield* ref.send(ConnectingEvents.Dismissed({ attempt: first }))
      yield* at('Idle')
      expect(yield* Queue.size(said)).toBe(0)
    }),
  )

  it.effect('goes to the provider, and on the way back asks whether it went through', () =>
    Effect.gen(function* () {
      const { server, ref, at } = yield* started()
      yield* ref.send(pressOn(gmail))
      yield* at('Asking')
      yield* server.answer(signIn(gmailAccount))
      yield* at('Away')
      yield* ref.send(ConnectingEvents.Returned())
      yield* at('Checking')
      yield* server.answer(done(gmailAccount))
      yield* at('Connected')
      // The check is the same account picked up, not a second one begun.
      expect(server.asked).toEqual([begin(gmail), Asked.cases.Resume.make({ id: gmailAccount.id })])
    }),
  )

  it.effect('hears the account connect while the Person is still at the provider’s page', () =>
    Effect.gen(function* () {
      const { server, ref, at, arrived, said } = yield* started()
      const unfinished = account('a1', gmail, ConnectionState.cases.NeedsAuthorization.make({}))
      yield* ref.send(pressOn(gmail, { card: 'call-1' }))
      yield* at('Asking')
      yield* server.answer(signIn(unfinished))
      yield* at('Away')
      // Another account, and this one not yet usable, do not end it; this one usable does.
      yield* Queue.offer(arrived, account('other', notion))
      yield* Queue.offer(arrived, unfinished)
      yield* Queue.offer(arrived, gmailAccount)
      const snapshot = yield* at('Connected')
      expect(standingOf(snapshot.state, gmail)).toEqual(
        Standing.cases.Connected.make({ connection: gmailAccount }),
      )
      expect(yield* Queue.take(said)).toEqual([Option.some('call-1'), gmailAccount.id])
      // The server was asked once: nothing was checked, because nobody came back.
      expect(server.asked).toEqual([begin(gmail)])
    }),
  )

  it.effect('lets a card say where its own attempt stands, whatever it pressed', () =>
    Effect.gen(function* () {
      const { ref, at } = yield* started()
      yield* ref.send(pressOn(gmail, { card: 'call-1' }))
      const asking = yield* at('Asking')
      expect(standingOfCard(asking.state, 'call-1')).toEqual(Standing.cases.Starting.make({}))
      expect(standingOfCard(asking.state, 'call-2')).toEqual(Standing.cases.Still.make({}))
      // A row speaks by what was pressed; another row is still, and nothing can be pressed.
      expect(standingOf(asking.state, gmail)).toEqual(Standing.cases.Starting.make({}))
      expect(standingOf(asking.state, notion)).toEqual(Standing.cases.Still.make({}))
      expect(isWaiting(asking.state)).toBe(true)
    }),
  )

  it.effect('says the sign-in is still to do when the Person comes back without it', () =>
    Effect.gen(function* () {
      const { server, ref, at, said } = yield* started()
      yield* ref.send(pressOn(gmail))
      yield* at('Asking')
      yield* server.answer(signIn(gmailAccount))
      yield* at('Away')
      yield* ref.send(ConnectingEvents.Returned())
      yield* at('Checking')
      yield* server.answer(signIn(gmailAccount))
      const back = yield* at('Unfinished')
      expect(standingOf(back.state, gmail)).toEqual(Standing.cases.Unfinished.make({}))
      expect(isWaiting(back.state)).toBe(false)
      expect(yield* Queue.size(said)).toBe(0)
    }),
  )

  it.effect('takes a return that comes before the page is known to have opened', () =>
    Effect.gen(function* () {
      // A browser that has not said it opened: the app is back in front first.
      const { server, ref, at } = yield* started({ ...working, heldPage: true })
      yield* ref.send(pressOn(gmail))
      yield* at('Asking')
      yield* server.answer(signIn(gmailAccount))
      yield* at('Opening')
      yield* ref.send(ConnectingEvents.Returned())
      yield* at('Checking')
      yield* server.answer(done(gmailAccount))
      yield* at('Connected')
    }),
  )

  it.effect('takes no press while it is checking, and takes one from the key form', () =>
    Effect.gen(function* () {
      const { server, ref, at } = yield* started()
      yield* ref.send(pressOn(gmail))
      yield* at('Asking')
      yield* server.answer(signIn(gmailAccount))
      yield* at('Away')
      yield* ref.send(ConnectingEvents.Returned())
      yield* at('Checking')
      // Checking waits on the server, so this press is not taken and the check stands.
      yield* ref.send(pressOn(notion, { attempt: second }))
      yield* server.answer(key(gmailAccount))
      const keying = yield* at('Keying')
      expect(attemptOf(keying.state)).toEqual(Option.some(first))
      // From the key form a press is taken, and the form's attempt is over.
      yield* ref.send(pressOn(notion, { attempt: second }))
      yield* at('Asking')
      yield* server.answer(done(account('n1', notion)))
      const snapshot = yield* at('Connected')
      expect(attemptOf(snapshot.state)).toEqual(Option.some(second))
      // Three questions: the first press, the check, and the press from the key form.
      expect(server.asked.map((question) => question._tag)).toEqual(['Begin', 'Resume', 'Begin'])
    }),
  )

  it.effect('takes a key for its own attempt and account, and brings the form up for it', () =>
    Effect.gen(function* () {
      const { server, ref, at, forms, said } = yield* started()
      yield* ref.send(pressOn(gmail, { card: 'call-1' }))
      yield* at('Asking')
      yield* server.answer(key(gmailAccount))
      const keying = yield* at('Keying')
      expect(Standing.guards.Keying(standingOf(keying.state, gmail))).toBe(true)
      expect(isWaiting(keying.state)).toBe(false)
      // Another account's key being taken elsewhere is not this form's.
      yield* ref.send(
        ConnectingEvents.Finished({ attempt: first, connection: account('other', notion), at: 0 }),
      )
      yield* ref.send(
        ConnectingEvents.Finished({ attempt: first, connection: gmailAccount, at: 0 }),
      )
      yield* at('Connected')
      expect(yield* Queue.take(said)).toEqual([Option.some('call-1'), gmailAccount.id])
      expect(forms).toEqual([first])
    }),
  )

  it.effect('does not let a form left from a replaced attempt finish or close the new one', () =>
    Effect.gen(function* () {
      const made = yield* replaced()
      // The first form answers late, about the same account, and is then closed. Each is waited
      // for until the machine has dealt with it, and after each the second attempt's form stands:
      // a closing that was wrongly taken would otherwise pass for the rightful one below.
      for (const late of [
        ConnectingEvents.Finished({ attempt: first, connection: gmailAccount, at: 0 }),
        ConnectingEvents.Dismissed({ attempt: first }),
      ]) {
        const step = yield* made.probe.sendAndAwait(late)
        expect(step.handled).toBe(false)
        expect(ConnectingStates.matches(step.after, 'Keying')).toBe(true)
        expect(attemptOf(step.after)).toEqual(Option.some(second))
      }
      const closed = yield* made.probe.sendAndAwait(ConnectingEvents.Dismissed({ attempt: second }))
      expect(closed.handled).toBe(true)
      expect(ConnectingStates.matches(closed.after, 'Idle')).toBe(true)
      yield* saidOnly(made, [])
    }),
  )

  it.effect.prop(
    'ends a key attempt only by its own form on its own account, and says so once',
    {
      before: outsiders,
      // The own form's answer about the own account is always among what is said, so every case
      // ends the attempt: here, or earlier when something generated before it already did.
      ending: outsideSaid.pipe(
        Arbitrary.map((from) =>
          MachineTest.sendCommand(
            outside({ ...from, closes: false, attempt: 'second', account: 'a1' }),
          ),
        ),
      ),
      after: outsiders,
    },
    ({ before, ending, after }) =>
      Effect.gen(function* () {
        const made = yield* replaced()
        const run = yield* MachineTest.runCausalCommands(
          made.probe,
          [...before, ending, ...after],
          {
            initialModel: keyFormOpen,
            transition: (was, command) => {
              const now = ruled(was.stand, command)
              return Effect.succeed({ model: now, expected: now })
            },
            // Each saying has been dealt with when this runs, taken or not.
            assert: ({ expected, result }) =>
              Predicate.isTagged(result, 'SendProcessed')
                ? Effect.sync(() => {
                    const { step } = result
                    expect(step.handled).toBe(expected.moved)
                    expect(ConnectingStates.matches(step.after, expected.stand)).toBe(true)
                    expect(attemptOf(step.after)).toEqual(
                      expected.stand === 'Idle' ? Option.none() : Option.some(second),
                    )
                    expect(
                      step.plan.emittedEvents.map((event) => [event.card, event.connection.id]),
                    ).toEqual(expected.says)
                  })
                : Effect.fail(result._tag),
          },
        )
        yield* saidOnly(
          made,
          run.records.flatMap((record) => record.expected.says),
        )
      }),
    generated,
  )

  it.effect.prop(
    'takes nothing while the server or the page is waited on, and asks nothing twice',
    {
      asking: Arbitrary.array(pressing, { maxLength: 4 }),
      opening: untaken,
      checking: untaken,
      away: Schema.Literals([0, OWED, OWED + 1]),
      usable: Schema.Boolean,
    },
    ({ asking, opening, checking, away, usable }) =>
      Effect.gen(function* () {
        const made = yield* started({ ...working, heldPage: true })
        const { server, probe, ref, at } = made
        /** Says each and waits until the machine has dealt with it: none is taken, and the first attempt waits on. */
        const notTaken = (waiting: 'Asking' | 'Opening' | 'Checking', said: typeof opening) =>
          MachineTest.runCausalCommands(probe, said, {
            initialModel: waiting,
            transition: (model) => Effect.succeed({ model, expected: model }),
            assert: ({ expected, result }) =>
              Predicate.isTagged(result, 'SendProcessed')
                ? Effect.sync(() => {
                    expect(result.step.handled).toBe(false)
                    expect(ConnectingStates.matches(result.step.after, expected)).toBe(true)
                    expect(attemptOf(result.step.after)).toEqual(Option.some(first))
                  })
                : Effect.fail(result._tag),
          })
        // The press and the presses behind it are only put in the machine's queue, as a screen
        // puts them: none has been dealt with when the next is said. The queue is taken in
        // order, so one more saying that is waited for shows every one before it was dealt with.
        yield* ref.send(pressOn(gmail, { card: 'call-1' }))
        yield* Effect.forEach(asking, (press) => ref.send(press))
        yield* notTaken('Asking', [returnedBehind])
        yield* server.answer(signIn(gmailAccount))
        yield* at('Opening')
        yield* notTaken('Opening', opening)
        yield* made.open
        yield* at('Away')
        // The Person is away this long; the check's answer is timed by the machine's own clock.
        yield* TestClock.adjust(away)
        yield* probe.sendAndAwait(ConnectingEvents.Returned())
        yield* notTaken('Checking', checking)
        yield* server.answer(done(usable ? gmailAccount : refusedKey))
        const ended = yield* at(usable ? 'Connected' : 'Refused')
        expect(attemptOf(ended.state)).toEqual(Option.some(first))
        // Two questions in all, the press and the check on the way back: no press asked another.
        expect(server.asked).toEqual([
          begin(gmail),
          Asked.cases.Resume.make({ id: gmailAccount.id }),
        ])
        // An account that cannot be used is never said to have connected; one that can is said
        // once, with the card while ten minutes from the press have not passed.
        const card = away <= OWED ? Option.some('call-1') : Option.none()
        yield* saidOnly(made, usable ? [[card, gmailAccount.id]] : [])
      }),
    generated,
  )

  it.effect.each(deadline)(
    'names the card for a key form answered $moment only while the card is owed',
    ({ past, owed }) =>
      Effect.gen(function* () {
        // The second attempt was pressed at `PRESSED`; the form says the moment of its own answer.
        const made = yield* replaced()
        const step = yield* made.probe.sendAndAwait(
          ConnectingEvents.Finished({
            attempt: second,
            connection: gmailAccount,
            at: PRESSED + OWED + past,
          }),
        )
        const says: ReadonlyArray<Heard> = [
          [owed ? Option.some('call-2') : Option.none(), gmailAccount.id],
        ]
        // The account connects either way; only whether the card is named differs.
        expect(step.handled).toBe(true)
        expect(ConnectingStates.matches(step.after, 'Connected')).toBe(true)
        expect(step.plan.emittedEvents.map((event) => [event.card, event.connection.id])).toEqual(
          says,
        )
        yield* saidOnly(made, says)
      }),
  )

  it.effect.each(deadline)(
    'names the card for a sign-in checked $moment only while the card is owed',
    ({ past, owed }) =>
      Effect.gen(function* () {
        const made = yield* started()
        const { server, probe, at } = made
        yield* probe.sendAndAwait(pressOn(gmail, { card: 'call-1', at: PRESSED }))
        yield* server.answer(signIn(gmailAccount))
        yield* at('Away')
        // Nobody says this moment to the machine: its own check reads the clock when the server
        // answers, so the clock is put there before the Person comes back.
        yield* TestClock.setTime(PRESSED + OWED + past)
        yield* probe.sendAndAwait(ConnectingEvents.Returned())
        yield* server.answer(done(gmailAccount))
        yield* at('Connected')
        yield* saidOnly(made, [[owed ? Option.some('call-1') : Option.none(), gmailAccount.id]])
      }),
  )

  it.effect('ends refused, and says nothing, when the service did not accept the key', () =>
    Effect.gen(function* () {
      const { server, ref, at, said } = yield* started()
      yield* ref.send(pressOn(gmail, { card: 'call-1' }))
      yield* at('Asking')
      yield* server.answer(key(gmailAccount))
      yield* at('Keying')
      // The server keeps the account, unusable, and takes no second key for it.
      yield* ref.send(ConnectingEvents.Finished({ attempt: first, connection: refusedKey, at: 0 }))
      const refused = yield* at('Refused')
      expect(standingOf(refused.state, gmail)).toEqual(
        Standing.cases.Refused.make({
          refusal: Refusal.cases.Unusable.make({ serviceName: gmail }),
        }),
      )
      expect(yield* Queue.size(said)).toBe(0)
    }),
  )

  it.effect(
    'does not call an account connected when the server hands back one that cannot be used',
    () =>
      Effect.gen(function* () {
        const { server, ref, at, said } = yield* started()
        yield* ref.send(pressOn(gmail, { card: 'call-1' }))
        yield* at('Asking')
        yield* server.answer(done(refusedKey))
        const refused = yield* at('Refused')
        expect(standingOf(refused.state, gmail)).toEqual(
          Standing.cases.Refused.make({
            refusal: Refusal.cases.Unusable.make({ serviceName: gmail }),
          }),
        )
        expect(yield* Queue.size(said)).toBe(0)
      }),
  )

  it.effect('says so when there is nowhere to show the form for a key', () =>
    Effect.gen(function* () {
      const { server, ref, at } = yield* started({ ...working, noForm: true })
      yield* ref.send(pressOn(gmail))
      yield* at('Asking')
      yield* server.answer(key(gmailAccount))
      const refused = yield* at('Refused')
      expect(standingOf(refused.state, gmail)).toEqual(
        Standing.cases.Refused.make({
          refusal: Refusal.cases.Unshown.make({ serviceName: gmail }),
        }),
      )
    }),
  )

  it.effect('says why when the server refuses and when the page cannot be opened', () =>
    Effect.gen(function* () {
      const refused = yield* started()
      yield* refused.ref.send(pressOn(gmail))
      yield* refused.at('Asking')
      yield* refused.server.refuse
      const notBegun = yield* refused.at('Refused')
      expect(standingOf(notBegun.state, gmail)).toEqual(
        Standing.cases.Refused.make({ refusal: Refusal.cases.NotBegun.make({}) }),
      )

      const blocked = yield* started({ ...working, page: Option.some('Blocked') })
      yield* blocked.ref.send(pressOn(gmail))
      yield* blocked.at('Asking')
      yield* blocked.server.answer(signIn(gmailAccount))
      const stopped = yield* blocked.at('Refused')
      expect(standingOf(stopped.state, gmail)).toEqual(
        Standing.cases.Refused.make({
          refusal: Refusal.cases.Blocked.make({ serviceName: gmail }),
        }),
      )
    }),
  )
})
