import NodeProcess from 'node:process'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'
import { extractText } from 'unpdf'
import { ExtractionRpcs } from './contract.ts'
import { rejectionOf } from './rejection.ts'

/**
 * unpdf 1.8.1 dist/index.mjs:383-391 returns one string per page with mergePages:false.
 * index.mjs:90-97 loads before finally; only the parser's known names prove content rejection.
 * Classify this one Promise rejection ingress; import/page/destroy faults stay retryable.
 * The parent owns this process's lifecycle.
 */
const extractPages = Effect.fn('LibraryExtractor.extractPages')(function* (bytes: Uint8Array) {
  const result = yield* Effect.tryPromise({
    try: () => extractText(bytes, { mergePages: false }),
    catch: rejectionOf,
  })
  return result.text
})

/**
 * The official runner in its child-process mode: with no `parentPort` it serves over `process.send`
 * and `process.on('message')` (NodeWorkerRunner.ts:35-45, 62, 80) and sends the ready message `[0]`
 * itself (:120). RpcServer.ts:837-853 and :1492 install it. This module imports the contract leaf
 * only, so no parent orchestration and no library state is loaded into the process.
 */
const handlers = ExtractionRpcs.toLayer({ ExtractPdf: ({ bytes }) => extractPages(bytes) })
const server = RpcServer.layer(ExtractionRpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
)

/**
 * Completes when the IPC channel to the parent closes. The runner does not listen for `disconnect`
 * and `runMain` keeps the process alive, so without this an idle process would outlive a parent
 * that died without stopping it. The listener is removed if the race is decided the other way.
 *
 * Limit, stated: the event is delivered by the event loop. A process blocked in synchronous
 * JavaScript does not see it and runs on; only the parent's `stop` or the host ends that process.
 */
const parentGone = Effect.callback<void>((resume) => {
  const onDisconnect = () => resume(Effect.void)
  NodeProcess.once('disconnect', onDisconnect)
  return Effect.sync(() => {
    NodeProcess.off('disconnect', onDisconnect)
  })
})

/**
 * Executable process ingress owns the Effect runtime. The parent never asks this process to close;
 * it kills the process group and awaits the native exit. Losing the parent ends the program, and
 * NodeRuntime.ts:58-65 then lets the process exit naturally.
 */
NodeRuntime.runMain(Effect.raceFirst(Layer.launch(server), parentGone))
