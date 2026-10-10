import { describe, expect, it } from '@effect/vitest'
import { Machine } from '@typeonce/effect-machine'
import {
  ConnectionId,
  ConnectionOwnership,
  ConnectionState,
  ConnectionStep,
  PersonId,
  ServiceId,
  type Connection,
} from '@vivid/contracts'
import { Effect, Layer, Option, Queue, Result, Stream } from 'effect'
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

/** A press on a service at the test clock's start, as the attempt named. */
const pressOn = (
  service: ServiceId,
  said: { readonly attempt?: AttemptId; readonly card?: string } = {},
) =>
  ConnectingEvents.Press({
    attempt: said.attempt === undefined ? first : said.attempt,
    pressed: service,
    card: Option.fromUndefinedOr(said.card),
    asked: begin(service),
    at: 0,
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

/** Starts the machine against a hand-answered server and says where it stands. */
/** What a case may make go wrong: the page cannot be opened, or there is nowhere to show a key form. */
interface Faults {
  readonly page: Option.Option<PageRefused['reason']>
  readonly noForm: boolean
}
const working: Faults = { page: Option.none(), noForm: false }

/** Starts the machine against a hand-answered server and says where it stands. */
const started = ({ page, noForm }: Faults = working) =>
  Effect.gen(function* () {
    const server = yield* makeServer()
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
      Effect.provide(Layer.mergeAll(server.layer, browser(page), keyForm, arrivals)),
    )
    /** Every account the machine said it connected, in order, with the card it named. */
    const said = yield* Queue.unbounded<readonly [Option.Option<string>, Connection['id']]>()
    yield* Effect.forkScoped(
      Stream.runForEach(ref.emissions, (event) =>
        Queue.offer(said, [event.card, event.connection.id]),
      ),
    )
    const at = (path: Parameters<typeof ConnectingStates.matches>[1]) =>
      Machine.waitFor(ref, (snapshot) => ConnectingStates.matches(snapshot.state, path))
    return { server, ref, at, forms, arrived, said }
  })

const gmailAccount = account('a1', gmail)
const refusedKey = account(
  'a1',
  gmail,
  ConnectionState.cases.Failed.make({ reason: 'The key was not accepted.' }),
)

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
      const server = yield* makeServer()
      // A browser that never says it opened: the app is back in front first.
      const slow = Layer.succeed(SignInPage, { open: () => Effect.never })
      const ref = yield* Machine.start(Connecting).pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- This case alone needs a page that never opens; the services hold no resource.
        Effect.provide(
          Layer.mergeAll(
            server.layer,
            slow,
            Layer.succeed(KeyForm, { show: () => Effect.void }),
            Layer.succeed(Arrivals, { of: () => Stream.never }),
          ),
        ),
      )
      const at = (path: Parameters<typeof ConnectingStates.matches>[1]) =>
        Machine.waitFor(ref, (snapshot) => ConnectingStates.matches(snapshot.state, path))
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

  it.effect('does not let a form left from a replaced attempt finish the new one', () =>
    Effect.gen(function* () {
      const { server, ref, at, said } = yield* started()
      // The first attempt's form is open on the account; the Person presses the account again.
      yield* ref.send(pressOn(gmail, { card: 'call-1' }))
      yield* at('Asking')
      yield* server.answer(key(gmailAccount))
      yield* at('Keying')
      yield* ref.send(pressOn(gmail, { attempt: second, card: 'call-2' }))
      yield* at('Asking')
      yield* server.answer(key(gmailAccount))
      yield* at('Keying')
      // The first form answers late, about the same account, and is then closed.
      yield* ref.send(
        ConnectingEvents.Finished({ attempt: first, connection: gmailAccount, at: 0 }),
      )
      yield* ref.send(ConnectingEvents.Dismissed({ attempt: first }))
      // The second attempt's own closing is taken, so the two before it were seen and refused:
      // the machine takes events in order.
      yield* ref.send(ConnectingEvents.Dismissed({ attempt: second }))
      yield* at('Idle')
      expect(yield* Queue.size(said)).toBe(0)
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
      const { server, ref, at } = yield* started({ page: Option.none(), noForm: true })
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

      const blocked = yield* started({ page: Option.some('Blocked'), noForm: false })
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

  it.effect('owes a card its carry-on for ten minutes from the press, in whatever state', () =>
    Effect.gen(function* () {
      // On time: the key is taken at the last moment the card is still owed.
      const onTime = yield* started()
      yield* onTime.ref.send(pressOn(gmail, { card: 'call-1' }))
      yield* onTime.at('Asking')
      yield* onTime.server.answer(key(gmailAccount))
      yield* onTime.at('Keying')
      yield* onTime.ref.send(
        ConnectingEvents.Finished({ attempt: first, connection: gmailAccount, at: 10 * 60_000 }),
      )
      expect(yield* Queue.take(onTime.said)).toEqual([Option.some('call-1'), gmailAccount.id])

      // A millisecond late, with the key form left open: the account connects, no card is named.
      const late = yield* started()
      yield* late.ref.send(pressOn(gmail, { card: 'call-1' }))
      yield* late.at('Asking')
      yield* late.server.answer(key(gmailAccount))
      yield* late.at('Keying')
      yield* late.ref.send(
        ConnectingEvents.Finished({
          attempt: first,
          connection: gmailAccount,
          at: 10 * 60_000 + 1,
        }),
      )
      expect(yield* Queue.take(late.said)).toEqual([Option.none(), gmailAccount.id])

      // The same through the machine's own call: the Person was away past the deadline, and the
      // moment is read from the clock when the server answers the check.
      const away = yield* started()
      yield* away.ref.send(pressOn(gmail, { card: 'call-1' }))
      yield* away.at('Asking')
      yield* away.server.answer(signIn(gmailAccount))
      yield* away.at('Away')
      yield* TestClock.adjust('11 minutes')
      yield* away.ref.send(ConnectingEvents.Returned())
      yield* away.at('Checking')
      yield* away.server.answer(done(gmailAccount))
      expect(yield* Queue.take(away.said)).toEqual([Option.none(), gmailAccount.id])
    }),
  )
})
