import { encodeState, type PersistedState, type StateService } from 'alchemy/State'
import { makeLocalState } from 'alchemy/State/LocalState'
import { PlatformServices } from 'alchemy/Util/PlatformServices'
import * as Arr from 'effect/Array'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Equal from 'effect/Equal'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Order from 'effect/Order'
import * as Schema from 'effect/Schema'
import { openStore, readStage } from '../state.ts'
import { parseDeployTarget } from '../targets.ts'

/**
 * Copies the production stack's state from a `.alchemy` directory into the hosted state store
 * (`infra/state.ts`), once, when the state moves off the PC. Run it from a directory holding an
 * extracted copy of the old state, never the live one, with the two store settings in the
 * environment (`docs/19-infrastructure.md`, "Where the stack's state lives"):
 *
 *   cd <copy holding .alchemy> && node <repository>/infra/copy/main.ts
 *
 * Alchemy's own `syncState` (`alchemy/src/State/Sync.ts`) is not used: it walks every stack in the
 * source whatever `stacks` says, and deletes every destination stack the source lacks, which here
 * is the store's own `CloudflareStateStore` stack.
 */

/** The destination already holds different state for the stage; a deploy has written it since. */
class StateCopyRefused extends Schema.TaggedError<StateCopyRefused>()(
  'StateCopyRefused',
  { stack: Schema.String, stage: Schema.String, message: Schema.String },
  { title: 'State copy refused' },
) {}

/** A value read back from the store differs from the one written. */
class StateCopyMismatch extends Schema.TaggedError<StateCopyMismatch>()(
  'StateCopyMismatch',
  { fqn: Schema.String, message: Schema.String },
  { title: 'State copy mismatch' },
) {}

/** The JSON a store persists for a record, secrets marked as Alchemy marks them, to compare by. */
const persisted = (value: PersistedState): string => JSON.stringify(encodeState(value))

/**
 * The stage's persisted form: every record, and the stack output when the stage has one. Alchemy
 * types an output as `unknown` and a stage that never finished a deploy has none.
 */
const snapshot = Effect.fn('snapshot')(function* (
  store: StateService,
  stack: string,
  stage: string,
) {
  const records = yield* readStage(store, stack, stage)
  const output = yield* store.getOutput({ stack, stage })
  return {
    records: new Map(
      Arr.sort(
        records.map(({ fqn, value }) => [fqn, persisted(value)] as const),
        Order.mapInput(Order.String, ([fqn]: readonly [string, string]) => fqn),
      ),
    ),
    output:
      output === undefined
        ? Option.none<string>()
        : Option.some(JSON.stringify(encodeState(output))),
  }
})

type Snapshot = Effect.Success<ReturnType<typeof snapshot>>

/** Names the first record whose persisted form differs, or `output` for the stack output. */
const firstDifference = (left: Snapshot, right: Snapshot) => {
  const fqns = new Set([...left.records.keys(), ...right.records.keys()])
  const fqn = [...fqns].find((key) => left.records.get(key) !== right.records.get(key))
  if (fqn !== undefined) return fqn
  return Equal.equals(left.output, right.output) ? undefined : 'output'
}

const copyState = Effect.fn('copyState')(function* () {
  const { stackName: stack, stage } = yield* parseDeployTarget('production')
  const source = yield* makeLocalState()
  const destination = yield* openStore()

  const original = yield* snapshot(source, stack, stage)
  if (original.records.size === 0) {
    return yield* new StateCopyRefused({
      stack,
      stage,
      message: 'The source holds no state for this stage; run from the copy holding .alchemy',
    })
  }

  /**
   * Empty means no records and no output. A destroy deletes records before the output
   * (`alchemy/src/Apply.ts`), so an output alone is a stage someone touched, not a free one.
   */
  const existing = yield* snapshot(destination, stack, stage)
  const empty = existing.records.size === 0 && Option.isNone(existing.output)
  if (!empty && firstDifference(original, existing) !== undefined) {
    return yield* new StateCopyRefused({
      stack,
      stage,
      message: 'The store already holds different state for this stage; it is not overwritten',
    })
  }

  /** Values go through `get` and `set` so each store applies its own encoding and encryption. */
  yield* Effect.forEach(original.records.keys(), (fqn) =>
    Effect.flatMap(source.get({ stack, stage, fqn }), (value) =>
      value === undefined ? Effect.void : destination.set({ stack, stage, fqn, value }),
    ),
  )
  const output = yield* source.getOutput({ stack, stage })
  if (output !== undefined) yield* destination.setOutput({ stack, stage, value: output })

  const copied = yield* snapshot(destination, stack, stage)
  const mismatch = firstDifference(original, copied)
  if (mismatch !== undefined) {
    return yield* new StateCopyMismatch({
      fqn: mismatch,
      message: `${mismatch} reads back different from the source`,
    })
  }
  yield* Console.log(`copied ${copied.records.size} records and the output of ${stack}/${stage}`)
})

/** A script entry point: the platform Layer Alchemy's CLI uses, and fetch for the store. */
await Effect.runPromise(
  // @effect-diagnostics-next-line strictEffectProvide:off -- This file is the program's entry point.
  copyState().pipe(Effect.provide(Layer.mergeAll(PlatformServices, FetchHttpClient.layer))),
)
