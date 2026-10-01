import { VividRpcClient } from '@vivid/client-runtime'
import type { RpcFailure } from '@vivid/contracts/rpc'
import { Cause, Data, Effect, Layer, Option, Result, Stream } from 'effect'
import type * as RpcClientError from 'effect/unstable/rpc/RpcClientError'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'

/** Everything a product call can fail with: what the server said, or that it could not be reached. */
export type ProductFailure = RpcFailure | RpcClientError.RpcClientError

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

/** What a screen draws for an atom's current value. A failure with a last result keeps showing it. */
export const liveStateOf = <Value>(result: LiveResult<Value>): LiveState<Value> =>
  AsyncResult.match(result, {
    onInitial: () => LiveState.Loading(),
    onSuccess: (success) => LiveState.Ready({ value: success.value }),
    onFailure: (failure) =>
      Option.match(failure.previousSuccess, {
        onSome: (previous) => LiveState.Ready({ value: previous.value }),
        onNone: () =>
          Option.match(productFailure(failure.cause), {
            onNone: () => LiveState.Loading(),
            onSome: (reason) => LiveState.Failed({ failure: reason }),
          }),
      }),
  })

/** Says how an expected change ended: the server accepted it, or refused it. */
export type Settle = (accepted: boolean) => void

/**
 * One live query: an Effect Atom over a `Watch…` subscription.
 *
 * `atom` is what components read. It is the server's latest result with this client's pending
 * changes applied on top (`Atom.optimistic`), so a write shows at once, is confirmed by the next
 * result, and is rolled back if the server refuses it.
 */
export interface LiveQuery<Value> {
  readonly atom: Atom.Atom<LiveResult<Value>>
  /**
   * Shows a change now, before the server has confirmed it. Call the returned function when the
   * write finishes, saying whether it was accepted.
   */
  readonly expect: (change: (current: Value) => Value) => Settle
}

/** What `useLive` returns for a query, for code that names that type. */
export type LiveStateOf<Query> = Query extends LiveQuery<infer Value> ? LiveState<Value> : never

/** Every live query of one kind, one per argument. */
export interface LiveFamily<Argument, Value> {
  readonly get: (argument: Argument) => LiveQuery<Value>
}

/** Failures that mean "this is not yours to see", which asking again will not change. */
const FINAL = new Set(['Unauthenticated', 'Forbidden', 'NotFound', 'InvalidRequest'])

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

/**
 * The live data layer for one client: one Atom registry, one runtime atom that owns the socket,
 * and a query atom for every `Watch…` call. Web, mobile and desktop build this once from the
 * client Layer their platform provides and read the same atoms.
 *
 * Atoms subscribe when something first reads them and stay subscribed for half a minute after the
 * last reader leaves (the registry's idle TTL), so going back to a screen shows it at once. Nothing
 * here polls and nothing is refetched: the server sends a result when it changes.
 */
export function makeLive(layer: Layer.Layer<VividRpcClient>) {
  const registry = AtomRegistry.make({ defaultIdleTTL: 30_000 })
  const runtime = Atom.runtime(layer)
  // The client, and so the socket, lives for as long as the page does.
  registry.mount(runtime)

  const query = <Value>(
    watch: (client: Client) => Stream.Stream<Value, ProductFailure>,
  ): LiveQuery<Value> => {
    const source = runtime.atom(
      resilient(() =>
        Stream.unwrap(
          Effect.gen(function* () {
            return watch(yield* VividRpcClient)
          }),
        ),
      ),
    )
    const view = Atom.optimistic(source)
    return {
      atom: view,
      expect: (change) => {
        const current = registry.get(view)
        if (!AsyncResult.isSuccess(current)) return () => undefined
        const expected: LiveResult<Value> = AsyncResult.success(change(current.value))
        // A transition is itself an atom: waiting while the write is in flight, then success
        // (the source is refreshed and takes over) or failure (the view rolls back).
        const transition = Atom.make<AsyncResult.AsyncResult<LiveResult<Value>, unknown>>(
          AsyncResult.success(expected, { waiting: true }),
        )
        registry.set(view, transition)
        return (accepted) =>
          registry.set(
            transition,
            accepted
              ? AsyncResult.success(expected)
              : AsyncResult.fail('The server refused this change'),
          )
      },
    }
  }

  const family = <Argument, Value>(
    key: (argument: Argument) => string,
    watch: (client: Client, argument: Argument) => Stream.Stream<Value, ProductFailure>,
  ): LiveFamily<Argument, Value> => {
    const queries = new Map<string, LiveQuery<Value>>()
    return {
      get: (argument) => {
        const name = key(argument)
        const existing = queries.get(name)
        if (existing !== undefined) return existing
        const made = query((client) => watch(client, argument))
        queries.set(name, made)
        return made
      },
    }
  }

  /** Runs one program with the client the atoms use, on the same socket. */
  const run = <Value, Failure>(program: Effect.Effect<Value, Failure, VividRpcClient>) =>
    Effect.runPromise(
      Effect.result(
        Effect.flatMap(AtomRegistry.getResult(registry, runtime), (context) =>
          Effect.provideContext(program, context),
        ),
      ),
    )

  /**
   * Makes a change: shows it at once in every live query it touches, sends it, and tells each
   * expectation how it ended. On success the server's next result confirms it; on refusal the
   * expected change is taken back.
   */
  const change = async <Value>(
    program: (client: Client) => Effect.Effect<Value, ProductFailure>,
    ...expectations: ReadonlyArray<() => Settle>
  ) => {
    const settles = expectations.map((expectation) => expectation())
    const result = await run(
      Effect.gen(function* () {
        return yield* program(yield* VividRpcClient)
      }),
    )
    for (const settle of settles) settle(Result.isSuccess(result))
    return result
  }

  return { registry, query, family, run, change }
}
