import * as NodeUtil from 'node:util'
import { NodeRuntime } from '@effect/platform-node'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { Effect, ConfigProvider, Layer } from 'effect'
import { flueSourceLayer } from './source.ts'
import { readHistory, ReaderFailed } from './reader.ts'

/** Accept only the explicit source, notes, cell ingress, token file and output map arguments. */
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
        },
        strict: true,
      }),
    catch: () => new ReaderFailed({ operation: 'arguments' }),
  })
  const { source, notes, cells, token, map } = args.values
  if (
    source === undefined ||
    notes === undefined ||
    cells === undefined ||
    token === undefined ||
    map === undefined
  )
    return yield* new ReaderFailed({ operation: 'required arguments missing' })
  const urls = yield* Effect.try({
    try: () => cells.split(',').map((value) => new URL(value)),
    catch: () => new ReaderFailed({ operation: 'cell URL list' }),
  })
  const result = yield* readHistory({ notes, cells: urls, token, map }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off -- The CLI entry point owns the source pool for this run.
    Effect.provide(
      flueSourceLayer.pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ VIVID_FLUE_DATABASE_URL: source })),
        ),
      ),
    ),
  )
  yield* Effect.logInfo('History and receipts migrated', result)
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
