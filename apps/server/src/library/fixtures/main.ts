import * as NodeProcess from 'node:process'
import * as NodeWorkerThreads from 'node:worker_threads'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'
import { ExtractionFaulted, ExtractionRpcs } from '../extraction.ts'
import { Fixture } from './mode.ts'

const decodeInput = Schema.decodeUnknownSync(Fixture)
const input = decodeInput(NodeWorkerThreads.workerData)

/** Signal from inside the handler, then deliberately block JS so interrupt messages cannot run. */
const spin = (flag: SharedArrayBuffer): ReadonlyArray<string> => {
  const signal = new Int32Array(flag)
  Atomics.store(signal, 0, 1)
  Atomics.notify(signal, 0)
  for (;;) {}
}

/** Signal before allocation proves the heap error follows handler entry, rather than loader death. */
const grow = (flag: SharedArrayBuffer): ReadonlyArray<string> => {
  const signal = new Int32Array(flag)
  Atomics.store(signal, 0, 1)
  Atomics.notify(signal, 0)
  // Retained ordinary objects exhaust V8 old-generation heap, not external buffers.
  const retained: Array<ReadonlyArray<{ value: number }>> = []
  for (;;) retained.push(Array.from({ length: 10_000 }, (_, value) => ({ value })))
}

/** Exit before handshake tests the SDK's dead-thread buffering path independently of a request. */
if (Fixture.guards.absent(input)) NodeProcess.exit(1)

/** All fixtures use the production RPC contract and runner, including intentional handler death. */
const handlers = ExtractionRpcs.toLayer({
  ExtractPdf: () =>
    Fixture.match<Effect.Effect<ReadonlyArray<string>, ExtractionFaulted>>(input, {
      spin: ({ flag }) => Effect.sync(() => spin(flag)),
      grow: ({ flag }) => Effect.sync(() => grow(flag)),
      exit: () => Effect.sync(() => NodeProcess.exit(1)),
      defect: () =>
        Effect.sync(() => {
          throw new Error('Extraction fixture defect')
        }),
      faulted: () => Effect.fail(new ExtractionFaulted()),
      absent: () => Effect.sync(() => NodeProcess.exit(1)),
    }),
})
const server = RpcServer.layer(ExtractionRpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
)

/** The fixture has a real runtime and native Worker transport; tests own every spawned thread. */
NodeRuntime.runMain(Layer.launch(server))
