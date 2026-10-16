import { encodeState, type PersistedState, type StateService } from 'alchemy/State'
import { makeLocalState } from 'alchemy/State/LocalState'
import { PlatformServices } from 'alchemy/Util/PlatformServices'
import * as Arr from 'effect/Array'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as Layer from 'effect/Layer'
import * as Order from 'effect/Order'
import * as Schema from 'effect/Schema'
import { openStore } from '../state.ts'
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
export class StateCopyRefused extends Schema.TaggedError<StateCopyRefused>()(
  'StateCopyRefused',
  { stack: Schema.String, stage: Schema.String, message: Schema.String },
  { title: 'State copy refused' },
) {}

/** A value read back from the store differs from the one written. */
export class StateCopyMismatch extends Schema.TaggedError<StateCopyMismatch>()(
  'StateCopyMismatch',
  { fqn: Schema.String, message: Schema.String },
  { title: 'State copy mismatch' },
) {}

/**
 * A listed record that reads back as nothing. The Cloudflare store answers a value it cannot
 * decrypt that way (`alchemy/src/Cloudflare/StateStore/Store.ts`, `decryptEntry`), so it is a
 * failure here and never an absent record.
 */
export class StateRecordUnreadable extends Schema.TaggedError<StateRecordUnreadable>()(
  'StateRecordUnreadable',
  { fqn: Schema.String, message: Schema.String },
  { title: 'State record unreadable' },
) {}

/** The JSON a store persists for a record, secrets marked as Alchemy marks them, to compare by. */
const persisted = (value: PersistedState): string => JSON.stringify(encodeState(value))

/** The stage's persisted form: every record and the stack output. */
const snapshot = Effect.fn('snapshot')(function* (
  store: StateService,
  stack: string,
  stage: string,
) {
  const fqns = Arr.sort(yield* store.list({ stack, stage }), Order.String)
  const records = yield* Effect.forEach(fqns, (fqn) =>
    Effect.flatMap(store.get({ stack, stage, fqn }), (value) =>
      value === undefined
        ? Effect.fail(
            new StateRecordUnreadable({ fqn, message: `${fqn} is listed but reads empty` }),
          )
        : Effect.succeed([fqn, persisted(value)] as const),
    ),
  )
  /** Alchemy types a stack output as `unknown`; it is compared as the JSON the store keeps. */
  const output: string = JSON.stringify(encodeState(yield* store.getOutput({ stack, stage })))
  return { records: new Map(records), output }
})

type Snapshot = Effect.Success<ReturnType<typeof snapshot>>

/** Names the first record whose persisted form differs, or `output` for the stack output. */
const firstDifference = (left: Snapshot, right: Snapshot) => {
  const fqns = new Set([...left.records.keys(), ...right.records.keys()])
  const fqn = [...fqns].find((key) => left.records.get(key) !== right.records.get(key))
  if (fqn !== undefined) return fqn
  return left.output === right.output ? undefined : 'output'
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

  const existing = yield* snapshot(destination, stack, stage)
  if (existing.records.size > 0 && firstDifference(original, existing) !== undefined) {
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
  yield* destination.setOutput({ stack, stage, value: yield* source.getOutput({ stack, stage }) })

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
