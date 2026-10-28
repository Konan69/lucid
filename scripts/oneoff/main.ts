import * as NodeUtil from 'node:util'
import { NodeRuntime } from '@effect/platform-node'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { Config, Effect, ConfigProvider, Layer } from 'effect'
import { flueSourceLayer } from './source.ts'
import { readHistory, ReaderFailed, type Inputs } from './reader.ts'

/** Dry runs need only read authority; cell tokens and receipt adoption belong to import mode. */
const command = Effect.gen(function* () {
  const args = yield* Effect.try({
    try: () =>
      NodeUtil.parseArgs({
        options: {
          source: { type: 'string' },
          notes: { type: 'string' },
          cells: { type: 'string' },
          token: { type: 'string' },
          map: { type: 'string' },
          helix: { type: 'string' },
          'dry-run': { type: 'string' },
        },
        strict: true,
      }),
    catch: () => new ReaderFailed({ operation: 'arguments' }),
  })
  const { source, notes, cells, token, map } = args.values
  if (source === undefined || notes === undefined)
    return yield* new ReaderFailed({ operation: 'required arguments missing' })
  const helixSetting =
    args.values.helix === undefined ? yield* Config.String('VIVID_HELIX_URL') : args.values.helix
  const helix = yield* Effect.try({
    try: () => new URL(helixSetting),
    catch: () => new ReaderFailed({ operation: 'Helix URL' }),
  })
  let output: Inputs['output']
  const dryRun = args.values['dry-run']
  if (dryRun !== undefined) output = { mode: 'dry-run', file: dryRun }
  else {
    if (cells === undefined || token === undefined || map === undefined)
      return yield* new ReaderFailed({ operation: 'required import arguments missing' })
    const urls = yield* Effect.try({
      try: () => cells.split(',').map((value) => new URL(value)),
      catch: () => new ReaderFailed({ operation: 'cell URL list' }),
    })
    output = { mode: 'import', cells: urls, token, map }
  }
  const result = yield* readHistory({ notes, helix, output }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- The CLI entry point owns the source pool for this run.
    Effect.provide(
      flueSourceLayer.pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ VIVID_FLUE_DATABASE_URL: source })),
        ),
      ),
    ),
  )
  yield* Effect.logInfo(
    output.mode === 'dry-run' ? 'History bodies exported' : 'History and receipts migrated',
    result,
  )
}).pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off -- This CLI entry point provides the transport once for its whole scope.
  Effect.provide(FetchHttpClient.layer),
  Effect.scoped,
  Effect.catch((error) =>
    Effect.sync(() => {
      const reason = error instanceof ReaderFailed ? error.operation : error._tag
      process.stderr.write(`History reader failed (${reason})\n`)
      process.exitCode = 1
    }),
  ),
)
NodeRuntime.runMain(command)
