import * as NodeChildProcess from 'node:child_process'
import * as NodeProcess from 'node:process'
import * as NodeURL from 'node:url'
import * as NodeStream from '@effect/platform-node/NodeStream'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { type Running, type ProcessEnd, start, stop } from '../../extraction/process.ts'
import { CommandUnavailable, Extract, Ready } from './control.ts'

/** The prepared CLI owns its request channel, complete stdout, and native termination receipts. */
interface CommandControl {
  readonly request: Effect.Effect<void, CommandUnavailable | Schema.SchemaError>
  readonly printed: Effect.Effect<string, CommandUnavailable>
  readonly ended: Effect.Effect<typeof ProcessEnd.Type>
  readonly closed: Effect.Effect<void>
}

/** The assertion receives only an already prepared CLI and the observations needed to prove exit. */
export class Command extends Context.Service<Command, CommandControl>()(
  'LibraryExtractionFixture.Command',
) {}

const decodeReady = Schema.decodeUnknownEffect(Ready)
const encodeExtract = Schema.encodeEffect(Extract)

/** The production inbox retains a receipt that arrives before Layer acquisition attaches a reader. */
const ready = (running: Running) =>
  Effect.callback<typeof Ready.Type, Schema.SchemaError>((resume) => {
    running.inbox.attach((message) => resume(decodeReady(message)))
    return Effect.sync(() => running.inbox.detach())
  })

/** tsx 4.23.13 cli.mjs forwards IPC to its script without changing the production CLI arguments. */
const request = Effect.fn('LibraryExtractionFixture.request')(function* (running: Running) {
  const message = yield* encodeExtract(Extract.make({}))
  yield* Effect.callback<void, CommandUnavailable>((resume) => {
    running.child.send(message, (error) => {
      resume(error === null ? Effect.void : Effect.fail(new CommandUnavailable()))
    })
  })
})

/** Attach native close in the spawn tick, before a fast CLI failure can release its pipes. */
const spawn = (closed: Deferred.Deferred<void>) => {
  const child = NodeChildProcess.spawn(
    NodeProcess.execPath,
    [NodeURL.fileURLToPath(import.meta.resolve('tsx/cli')), 'src/library/fixtures/process/main.ts'],
    {
      cwd: NodeURL.fileURLToPath(new URL('../../../../', import.meta.url)),
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    },
  )
  child.once('close', () => Deferred.doneUnsafe(closed, Effect.void))
  return child
}

/**
 * Cold CLI and dependency preparation belongs to acquisition, before the assertion budget starts.
 * The original source extractPdf runs only after request. Reuse the real process observer and group
 * stop, then also await native close so neither an abandoned CLI nor its stdout pipe escapes scope.
 */
export const commandLayer = Layer.effect(
  Command,
  Effect.gen(function* () {
    const owned = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>()
        const running = yield* start(() => spawn(closed))
        return { running, closed }
      }),
      (resource) =>
        Effect.gen(function* () {
          yield* stop(resource.running)
          yield* Deferred.await(resource.closed)
        }),
    )
    const output = owned.running.child.stdout
    if (output === null) return yield* new CommandUnavailable()
    yield* Effect.raceFirst(
      ready(owned.running),
      Deferred.await(owned.running.ended).pipe(
        Effect.andThen(Effect.fail(new CommandUnavailable())),
      ),
    )
    return Command.of({
      request: request(owned.running),
      printed: Stream.mkString(
        Stream.decodeText(
          NodeStream.fromReadable({
            evaluate: () => output,
            onError: () => new CommandUnavailable(),
          }),
        ),
      ),
      ended: Deferred.await(owned.running.ended),
      closed: Deferred.await(owned.closed),
    })
  }),
)
