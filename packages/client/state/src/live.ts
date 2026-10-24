import { VividRpcClient } from '@vivid/client-runtime'
import type { SkillReadOnly } from '@vivid/contracts'
import type { InputAnswerFailure, RpcFailure } from '@vivid/contracts/rpc'
import {
  Cause,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Result,
  Schedule,
  Stream,
} from 'effect'
import type * as RpcClientError from 'effect/rpc/RpcClientError'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'

/** Everything a product call can fail with: what the server said, or that it could not be reached. */
export type ProductFailure =
  | RpcFailure
  | SkillReadOnly
  | InputAnswerFailure
  | RpcClientError.RpcClientError

type Client = VividRpcClient['Service']

/**
 * What a screen draws from one live query.
 * - `Loading`: subscribed, nothing received yet.
 * - `Ready`: the latest result, with any change this client is still waiting to have confirmed
 *   already applied. A dropped connection keeps the last result here while it reconnects.
 * - `Failed`: the query ended and will not be retried: the Person must sign in, or may not see
 *   this.
 */
export type LiveState<Value> = Data.TaggedEnum<{
  Loading: {}
  Ready: { readonly value: Value }
  Failed: { readonly failure: ProductFailure }
}>

interface LiveStateDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: LiveState<this['A']>
}

/** Constructors and exhaustive matching for `LiveState`. */
export const LiveState = Data.taggedEnum<LiveStateDefinition>()

/**
 * The Effect Atom value behind a live query: the latest result, or why there is none. A `Watch…`
 * stream never ends on its own; the "no element" case is only what a stream atom's type admits.
 */
export type LiveResult<Value> = AsyncResult.AsyncResult<
  Value,
  ProductFailure | Cause.NoSuchElementError
>

/** The product failure inside a cause, when it has one. Interruption and defects have none. */
const productFailure = (cause: Cause.Cause<ProductFailure | Cause.NoSuchElementError>) =>
  Option.filter(
    Cause.findErrorOption(cause),
    (error): error is ProductFailure => !Cause.isNoSuchElementError(error),
  )

/**
 * What a screen draws for an atom's current value.
 *
 * A product failure that reaches an atom is always a final one (anything else is retried before it
 * gets here), and a final one wins over whatever was on screen: when a session is revoked or a
 * Person is removed from a Company, what they could see a moment ago must stop being shown. Only a
 * failure with no product reason (an interruption, a defect) keeps the last result up.
 */
export const liveStateOf = <Value>(result: LiveResult<Value>): LiveState<Value> =>
  AsyncResult.match(result, {
    onInitial: () => LiveState.Loading(),
    onSuccess: (success) => LiveState.Ready({ value: success.value }),
    onFailure: (failure) =>
      Option.match(productFailure(failure.cause), {
        onSome: (reason) => LiveState.Failed({ failure: reason }),
        onNone: () =>
          Option.match(failure.previousSuccess, {
            onSome: (previous) => LiveState.Ready({ value: previous.value }),
            onNone: () => LiveState.Loading(),
          }),
      }),
  })

/** One change this client made and is waiting to hear about: how it alters a query's result. */
interface Expected<Value> {
  readonly id: number
  readonly change: (current: Value) => Value
}

/** Says how an expected change ended: the server accepted it, or refused it. */
export type Settle = (accepted: boolean) => void

/**
 * One live query: an Effect Atom over a `Watch…` subscription.
 *
 * `atom` is what components read. It is the server's latest result with this client's pending
 * changes applied on top, so a write shows at once, is confirmed by the next result, and is
 * rolled back if the server refuses it.
 *
 * The installed `Atom.optimistic` is not used for this. It is built for a request that answers
 * once: it accepts a new source value only when that value is no longer `waiting`, and every value
 * of a stream that is still open is `waiting`. Over a `Watch…` stream it showed the first result
 * and then nothing the server sent afterwards, which is the opposite of live.
 */
export interface LiveQuery<Value> {
  readonly atom: Atom.Atom<LiveResult<Value>>
  /**
   * Shows a change now, before the server has confirmed it. Call the returned function when the
   * write finishes, saying whether it was accepted.
   */
  readonly expect: (change: (current: Value) => Value) => Settle
}

/**
 * Where what a kept query shows came from.
 * - `nothing`: nothing to show yet.
 * - `device`: the last answer this device wrote down, shown until the server answers. It is
 *   drawn exactly as a live answer is, with no spinner and no banner: it is nearly always right,
 *   and the server's first answer replaces it within a moment of the socket opening.
 * - `server`: the server's own answer.
 */
export type Origin = 'nothing' | 'device' | 'server'

/**
 * A live query whose last answer a device keeps between launches (`snapshot.ts`), so the first
 * screen draws at once from what was last known and is then corrected by the server.
 *
 * The mechanism is T3 Code's (`refs/t3code/packages/client-runtime/src/state/shell.ts`,
 * `makeEnvironmentShellState`): state starts from the cached snapshot, marked `cached`, and the
 * first live result replaces it. Vivid's live cache is an Atom per query, not one reducer, so
 * the cached value is a `seed` atom beside the subscription: `atom` shows the seed only while the
 * subscription has not answered, and anything the server says, a refusal included, wins.
 */
export interface KeptQuery<Value> extends LiveQuery<Value> {
  /** What the server itself has said, never the seed. Only this is ever written down. */
  readonly answers: Atom.Atom<LiveResult<Value>>
  /** The answer this device kept from its last run, set once its store has been read. */
  readonly seed: Atom.Writable<Option.Option<Value>>
  readonly origin: Atom.Atom<Origin>
}

/** What `useLive` returns for a query, for code that names that type. */
export type LiveStateOf<Query> = Query extends LiveQuery<infer Value> ? LiveState<Value> : never

/** Every live query of one kind, one per argument. */
export interface LiveFamily<Argument, Value> {
  readonly get: (argument: Argument) => LiveQuery<Value>
}

/** Failures that mean "this is not yours to see", which asking again will not change. */
const FINAL = new Set(['Unauthenticated', 'Forbidden', 'NotFound', 'InvalidRequest'])

/** Whether a failure is one that asking again cannot change, so nothing should ask again. */
export const isFinal = (failure: ProductFailure): boolean => FINAL.has(failure._tag)

/**
 * A subscription that outlives a dropped connection. A failure that is not final (the socket
 * closed, the server restarted) re-opens the subscription after a moment, and the atom keeps its
 * last result meanwhile; a final one ends the stream and reaches the screen.
 */
const resilient = <Value, R>(
  open: () => Stream.Stream<Value, ProductFailure, R>,
): Stream.Stream<Value, ProductFailure, R> =>
  open().pipe(
    Stream.catchIf(
      (failure) => !FINAL.has(failure._tag),
      () => Stream.unwrap(Effect.as(Effect.sleep('1500 millis'), resilient(open))),
    ),
  )

/** Names each expected change, so the one that settles is the one that is taken down. */
let expectationCount = 0

/**
 * A live query over `source`: the server's latest result with this client's pending changes
 * applied on top, and the way to add one.
 */
function expecting<Value>(
  registry: AtomRegistry.AtomRegistry,
  source: Atom.Atom<LiveResult<Value>>,
): LiveQuery<Value> {
  // What this client has changed and not yet seen the server say. It lives as long as the view
  // that reads it and for the registry's idle time after, so a screen that unmounts for a moment
  // does not lose the fact that a write is in flight. It is not kept alive beyond that: a query
  // for every Thread ever opened would each leave one behind for the life of the page.
  const pending = Atom.make<ReadonlyArray<Expected<Value>>>([])
  const drop = (id: number) =>
    registry.set(
      pending,
      registry.get(pending).filter((expected) => expected.id !== id),
    )
  // The changes are functions of the current value, so a new result from the server is never
  // hidden behind an old guess: the guess is re-made from what the server just said.
  const view = Atom.make((get): LiveResult<Value> => {
    const result = get(source)
    const expected = get(pending)
    if (expected.length === 0 || !AsyncResult.isSuccess(result)) return result
    return AsyncResult.success(
      expected.reduce((value, next) => next.change(value), result.value),
      { waiting: result.waiting, timestamp: result.timestamp },
    )
  })
  return {
    atom: view,
    expect: (change) => {
      expectationCount += 1
      const id = expectationCount
      const before = registry.get(source)
      registry.set(pending, [...registry.get(pending), { id, change }])
      return (accepted) => {
        // Refused: the guess was wrong, take it back. Accepted and the server has already sent a
        // result since the guess was made: that result includes the change, so the guess is done.
        // Accepted and nothing new has arrived yet: keep the guess up until the next result does,
        // or the screen would flick back to the old value in between.
        if (!accepted || registry.get(source) !== before) {
          drop(id)
          return
        }
        const stop = registry.subscribe(source, () => {
          drop(id)
          stop()
        })
      }
    },
  }
}

/**
 * A kept query over one subscription: the seed stands in only while the subscription is still
 * `Initial`.
 *
 * A dropped connection never reaches the atom (`resilient`), so a device that launches with no
 * network goes on showing what it kept; a final refusal does reach it and has no earlier success
 * of its own, so a session that is gone stops showing the last Person's data at once.
 */
function keeping<Value>(
  registry: AtomRegistry.AtomRegistry,
  answers: Atom.Atom<LiveResult<Value>>,
): KeptQuery<Value> {
  // Kept alive: a seed is written once, at launch, and must still be there when the first
  // screen that reads its query mounts.
  const seed = Atom.keepAlive(Atom.make(Option.none<Value>()))
  const source = Atom.make((get): LiveResult<Value> => {
    const result = get(answers)
    if (!AsyncResult.isInitial(result)) return result
    return Option.match(get(seed), {
      onNone: () => result,
      onSome: (value) => AsyncResult.success(value, { waiting: true }),
    })
  })
  const made = expecting(registry, source)
  const origin = Atom.make((get): Origin => {
    if (AsyncResult.isSuccess(get(answers))) return 'server'
    return AsyncResult.isSuccess(get(source)) ? 'device' : 'nothing'
  })
  return { atom: made.atom, expect: made.expect, answers, seed, origin }
}

/**
 * Asks every ended query again. A query ends when the server says it is not this Person's to
 * see, and that answer is about where they were: after they switch workspace or sign in again
 * the same question can have a different answer, and nothing else would ever ask it.
 */
function reopenEnded(registry: AtomRegistry.AtomRegistry, sources: WeakMap<object, object>) {
  // Only a query something is reading, and only one that ended: an atom nobody has mounted
  // would be started just by being asked how it is.
  for (const atom of registry.getNodes().keys()) {
    if (Predicate.isString(atom) || !sources.has(atom)) continue
    if (AsyncResult.isFailure(registry.get(atom))) registry.refresh(atom)
  }
}

/**
 * Every live query of one kind, one per argument, each made the first time it is asked for and
 * the same object for as long as anything holds it.
 */
function familyOf<Argument, Value>(
  key: (argument: Argument) => string,
  make: (argument: Argument) => LiveQuery<Value>,
): LiveFamily<Argument, Value> {
  // Held weakly: the query for a Thread is the same object for as long as anything refers to
  // it (a screen, a mounted atom), and is collected once nothing does. A plain Map kept one,
  // with its atoms, for every Thread and folder visited since the page loaded.
  const queries = new Map<string, WeakRef<LiveQuery<Value>>>()
  // Takes a name out once its query has been collected, unless a newer query already has it.
  const forget = (name: string) => {
    const held = queries.get(name)
    if (held !== undefined && held.deref() === undefined) queries.delete(name)
  }
  // Browsers and Node report a collected query through FinalizationRegistry. Hermes (React
  // Native) has WeakRef but no FinalizationRegistry, and constructing one there threw
  // "Property 'FinalizationRegistry' doesn't exist" on the first signed-in render. Without it
  // the dead names are swept when the next query is made, which bounds the Map the same way.
  // The installed Effect source makes the same check in `Atom.family`
  // (effect/src/unstable/reactivity/Atom.ts).
  const remember: (made: LiveQuery<Value>, name: string) => void =
    typeof FinalizationRegistry === 'undefined'
      ? () => {
          for (const name of queries.keys()) forget(name)
        }
      : (
          (gone) => (made, name) =>
            gone.register(made, name)
        )(new FinalizationRegistry<string>(forget))
  const known = (name: string) =>
    Option.flatMap(Option.fromUndefinedOr(queries.get(name)), (held) =>
      Option.fromUndefinedOr(held.deref()),
    )
  return {
    get: (argument) => {
      const name = key(argument)
      return Option.getOrElse(known(name), () => {
        const made = make(argument)
        remember(made, name)
        queries.set(name, new WeakRef(made))
        return made
      })
    },
  }
}

/**
 * Who hears that the server no longer accepts this session.
 *
 * `gone` is run on that failure from the four places every call and every subscription
 * passes through (`subscription`, `ask`, `hold`, `run`), so an `Unauthenticated` is heard
 * whichever call it answers, not only the one that asks who is signed in: a session revoked from
 * another device is refused on whatever is asked next.
 */
function makeLeaving() {
  const leaving = new Set<() => void>()
  return {
    /** Tells everyone listening. Run by `refused` below, on the one failure that means it. */
    gone: Effect.sync(() => {
      for (const hear of leaving) hear()
    }),
    /** Hears, each time, that the server refused this session. Answers with the way to stop. */
    whenSessionGone: (hear: () => void) => {
      leaving.add(hear)
      return () => {
        leaving.delete(hear)
      }
    },
  }
}

/**
 * How long a query stays subscribed after the last screen reading it has gone: five minutes, so
 * moving between Threads, Projects and the Library in the course of a piece of work is instant
 * and current. It costs the server an open subscription, not a refetch.
 */
const IDLE_FOR_MS = 5 * 60_000

/**
 * The live data layer for one client: one Atom registry, one runtime atom that owns the socket,
 * and a query atom for every `Watch…` call. Web, mobile and desktop build this once from the
 * client Layer their platform provides and read the same atoms.
 *
 * Atoms subscribe when something first reads them and stay subscribed for `IDLE_FOR_MS` after the
 * last reader leaves (the registry's idle TTL), so going back to a screen shows it at once. Nothing
 * here polls and nothing is refetched: the server sends a result when it changes.
 */
export function makeLive(layer: Layer.Layer<VividRpcClient>) {
  const registry = AtomRegistry.make({ defaultIdleTTL: IDLE_FOR_MS })
  const runtime = Atom.runtime(layer)
  // The client, and so the socket, lives for as long as the page does.
  registry.mount(runtime)

  // Every query, by its subscription atom. `reopen` uses it to tell a query's atom from anything
  // else that is mounted. It also ties a query's life to its atom's: while the registry keeps the
  // atom warm the query is kept with it, so coming back to a screen finds the same warm query and
  // does not make a second, cold one. Once the atom is let go, both can be collected.
  const sources = new WeakMap<object, object>()

  const { gone, whenSessionGone } = makeLeaving()

  /** One `Watch…` subscription on the app's socket, reopened when the connection drops. */
  const subscription = <Value>(watch: (client: Client) => Stream.Stream<Value, ProductFailure>) =>
    runtime.atom(
      resilient(() =>
        Stream.unwrap(
          Effect.gen(function* () {
            return watch(yield* VividRpcClient)
          }),
        ),
      ).pipe(
        Stream.tapError((failure) =>
          Predicate.isTagged(failure, 'Unauthenticated') ? gone : Effect.void,
        ),
      ),
    )

  const query = <Value>(watch: (client: Client) => Stream.Stream<Value, ProductFailure>) => {
    const source = subscription(watch)
    const made = expecting(registry, source)
    sources.set(source, made)
    return made
  }

  /** A live query that can start from what the device kept (`keeping`). */
  const kept = <Value>(watch: (client: Client) => Stream.Stream<Value, ProductFailure>) => {
    const made = keeping(registry, subscription(watch))
    // `reopen` asks the subscription again, not the view over it.
    sources.set(made.answers, made)
    return made
  }

  const family = <Argument, Value>(
    key: (argument: Argument) => string,
    watch: (client: Client, argument: Argument) => Stream.Stream<Value, ProductFailure>,
  ) => familyOf(key, (argument: Argument) => query((client) => watch(client, argument)))

  /**
   * A question whose answer depends on something the Person is typing or choosing: a search.
   *
   * It is asked again once `argument` has rested on a new value for a moment, and the last answer
   * stays in the atom while the next one is on its way, so a list being searched never blinks to
   * empty between keystrokes. A dropped connection asks again; a refusal is the answer.
   */
  const ask = <Argument, Value>(
    argument: Atom.Atom<Argument>,
    call: (client: Client, argument: Argument) => Effect.Effect<Value, ProductFailure>,
  ): Atom.Atom<LiveResult<Value>> => {
    const rested = Atom.debounce(argument, '120 millis')
    return runtime.atom((get) => {
      const asked = get(rested)
      return Effect.gen(function* () {
        return yield* call(yield* VividRpcClient, asked)
      }).pipe(
        Effect.tapError((failure) =>
          Predicate.isTagged(failure, 'Unauthenticated') ? gone : Effect.void,
        ),
        Effect.retry({
          while: (failure) => !FINAL.has(failure._tag),
          schedule: Schedule.spaced('1500 millis'),
        }),
      )
    })
  }

  /**
   * Something held open on the server for as long as a screen reads it: "I am here".
   *
   * The atom opens `open`'s call when something first reads it, and closes it the moment nothing
   * does (no idle time: a Person who left a Thread is not kept present in it). It says nothing on
   * a timer: the server hears the call being open, and hears the client on the socket's own
   * pings. When `argument` changes the call is closed and opened again with the new value, so what
   * the server holds follows what is true now; a dropped connection opens it again as every
   * subscription does.
   */
  const hold = <Argument>(
    argument: Atom.Atom<Argument>,
    open: (client: Client, argument: Argument) => Stream.Stream<void, ProductFailure>,
  ): Atom.Atom<LiveResult<void>> =>
    Atom.setIdleTTL(
      runtime.atom((get) => {
        const said = get(argument)
        return resilient(() =>
          Stream.unwrap(
            Effect.gen(function* () {
              return open(yield* VividRpcClient, said)
            }),
          ),
        ).pipe(
          Stream.tapError((failure) =>
            Predicate.isTagged(failure, 'Unauthenticated') ? gone : Effect.void,
          ),
        )
      }),
      0,
    )

  /**
   * One program, given the client the atoms use, so it rides the same socket. The failure is in
   * the value (`Result`), not in the error channel: every caller draws a refusal, none lets one
   * escape. This describes the work; the app that owns the runtime runs it.
   */
  const run = <Value, Failure>(program: Effect.Effect<Value, Failure, VividRpcClient>) =>
    Effect.result(
      Effect.flatMap(AtomRegistry.getResult(registry, runtime), (context) =>
        Effect.provideContext(program, context),
      ).pipe(
        Effect.tapError((failure) =>
          Predicate.isTagged(failure, 'Unauthenticated') ? gone : Effect.void,
        ),
      ),
    )

  /**
   * Makes a change: shows it at once in every live query it touches, sends it, and tells each
   * expectation how it ended. On success the server's next result confirms it; on refusal the
   * expected change is taken back.
   *
   * The expectations are applied as soon as this starts running, before anything is sent. Every
   * one is settled however the call ends, including when it is interrupted or dies of something
   * that is not a refusal at all: an expectation left waiting would hold its guess on screen
   * forever and hide every later result from the server.
   */
  const change = <Value>(
    program: (client: Client) => Effect.Effect<Value, ProductFailure>,
    ...expectations: ReadonlyArray<() => Settle>
  ) =>
    Effect.suspend(() => {
      const settles = expectations.map((expectation) => expectation())
      return run(
        Effect.gen(function* () {
          return yield* program(yield* VividRpcClient)
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            const accepted = Exit.isSuccess(exit) && Result.isSuccess(exit.value)
            for (const settle of settles) settle(accepted)
          }),
        ),
      )
    })

  const reopen = () => reopenEnded(registry, sources)

  return { registry, query, kept, family, ask, hold, run, change, reopen, whenSessionGone }
}

/** One app's live engine: its registry, its queries and the way it describes a call. */
export type LiveEngine = ReturnType<typeof makeLive>
