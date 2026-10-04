import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as RpcServer from 'effect/unstable/rpc/RpcServer'
import { extractText } from 'unpdf'
import { ExtractionRpcs } from '../extraction.ts'
import { rejectionOf } from './rejection.ts'

/**
 * unpdf 1.8.1 dist/index.mjs:383-391 returns one string per page with mergePages:false.
 * index.mjs:90-97 loads before finally; only the parser's known names prove content rejection.
 * Classify this one Promise rejection ingress; import/page/destroy faults stay retryable.
 * The parent owns the native thread lifecycle.
 */
const extractPages = Effect.fn('LibraryExtractor.extractPages')(function* (bytes: Uint8Array) {
  const result = yield* Effect.tryPromise({
    try: () => extractText(bytes, { mergePages: false }),
    catch: rejectionOf,
  })
  return result.text
})

/** RpcServer.ts:837-853 and :1492 install the native runner; no library state enters this thread. */
const handlers = ExtractionRpcs.toLayer({ ExtractPdf: ({ bytes }) => extractPages(bytes) })
const server = RpcServer.layer(ExtractionRpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
)

/** Executable thread ingress owns the Effect runtime; the parent explicitly awaits native exit. */
NodeRuntime.runMain(Layer.launch(server))
