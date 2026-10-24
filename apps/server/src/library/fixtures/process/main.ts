import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeProcess from 'node:process'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import { getResolvedPDFJS } from 'unpdf'
import { extractPdf } from '../../extraction.ts'
import { CommandUnavailable, Extract, Ready } from './control.ts'
import { Pages } from './pages.ts'

/** Compile the shared stdout encoder once without adding another declaration of its wire shape. */
const encodePages = Schema.encodeEffect(Pages)
const encodeReady = Schema.encodeEffect(Ready)
const decodeExtract = Schema.decodeUnknownEffect(Extract)

/** Register the typed request listener before readiness, so extraction cannot run during setup. */
const requested = Effect.gen(function* () {
  const message = yield* encodeReady(Ready.make({}))
  yield* Effect.callback<typeof Extract.Type, CommandUnavailable | Schema.SchemaError>((resume) => {
    if (NodeProcess.send === undefined) return resume(Effect.fail(new CommandUnavailable()))
    const onMessage = (input: unknown) => resume(decodeExtract(input))
    NodeProcess.once('message', onMessage)
    NodeProcess.send(message, (error) => {
      if (error !== null) resume(Effect.fail(new CommandUnavailable()))
    })
    return Effect.sync(() => {
      NodeProcess.off('message', onMessage)
    })
  })
})

/** Print only after extractPdf has awaited native process termination and closed its RPC scope. */
const program = Effect.fn('LibraryExtractionFixture.main')(function* () {
  // unpdf 1.8.1 index.mjs getResolvedPDFJS loads the real parser without opening a document.
  // This prepares the CLI's dependencies only. extractPdf still forks its original source entry.
  yield* Effect.tryPromise({
    try: () => getResolvedPDFJS(),
    catch: () => new CommandUnavailable(),
  })
  yield* requested
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const bytes = yield* fs.readFile(
    yield* path.fromFileUrl(new URL('../readable.pdf', import.meta.url)),
  )
  const pages = yield* extractPdf(bytes)
  yield* Console.log(yield* encodePages(pages))
})

/** NodeRuntime lets success exit naturally; an unreleased process would keep E8 running. */
NodeRuntime.runMain(
  // @effect-diagnostics-next-line strictEffectProvide:off -- This fixture process's entry point owns its platform Layers for the whole process, so no narrower lifetime exists to hold them.
  program().pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
)
