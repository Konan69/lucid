import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { extractPdf } from '../../extraction.ts'
import { Pages } from './pages.ts'

/** Compile the shared stdout encoder once without adding another declaration of its wire shape. */
const encodePages = Schema.encodeEffect(Pages)

/** Print only after extractPdf has awaited native thread termination and closed its RPC scope. */
const program = Effect.fn('LibraryExtractionFixture.main')(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const bytes = yield* fs.readFile(
    yield* path.fromFileUrl(new URL('../readable.pdf', import.meta.url)),
  )
  const pages = yield* extractPdf(bytes)
  yield* Console.log(yield* encodePages(pages))
})

/** NodeRuntime.ts:58-65 lets success exit naturally; an unreleased thread would keep E8 running. */
NodeRuntime.runMain(
  program().pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
)
