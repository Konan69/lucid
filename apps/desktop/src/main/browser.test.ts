import * as NodeChildProcess from 'node:child_process'
import * as NodeURL from 'node:url'
import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import { describe, expect, layer } from '@effect/vitest'
import { Context, Effect, Layer, Schema } from 'effect'
import * as Esbuild from 'esbuild'
import electron from 'electron'

// Electron's Node entry returns its executable path; its browser declaration describes the API.
const electronExecutable = Schema.decodeUnknownSync(Schema.String)(electron)

class NativeProofFailed extends Schema.TaggedError<NativeProofFailed>()(
  'NativeProofFailed',
  {},
  { title: 'Native page proof failed' },
) {}
interface NativeProofService {
  readonly run: () => Effect.Effect<{ code: number | null; output: string }, NativeProofFailed>
}
class NativeProof extends Context.Service<NativeProof, NativeProofService>()('Test/NativePages') {}

/** Suite scope owns compilation and Chromium startup, independently of the operation's timeout. */
const nativeProofLayer = Layer.effect(
  NativeProof,
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/vivid-pages-`)),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    )
    const executable = `${directory}/pages.cjs`
    yield* Effect.tryPromise({
      try: () =>
        Esbuild.build({
          entryPoints: [NodeURL.fileURLToPath(new URL('../../scripts/pages.ts', import.meta.url))],
          bundle: true,
          platform: 'node',
          format: 'cjs',
          external: ['electron'],
          outfile: executable,
          logLevel: 'silent',
        }),
      catch: () => new NativeProofFailed({}),
    })
    const launched = yield* Effect.acquireRelease(
      Effect.callback<
        { child: NodeChildProcess.ChildProcessWithoutNullStreams; output: { text: string } },
        NativeProofFailed
      >((resume) => {
        const child = NodeChildProcess.spawn(
          '/usr/bin/xvfb-run',
          ['-a', electronExecutable, executable, `${directory}/profile`],
          { stdio: 'pipe' },
        )
        const output = { text: '' }
        child.stdout.on('data', (chunk: Buffer) => {
          output.text = (output.text + chunk.toString()).slice(-65536)
          if (output.text.includes('Vivid native pages ready'))
            resume(Effect.succeed({ child, output }))
        })
        child.stderr.on('data', (chunk: Buffer) => {
          output.text = (output.text + chunk.toString()).slice(-65536)
        })
        child.once('error', () => resume(Effect.fail(new NativeProofFailed({}))))
        child.once('close', () => resume(Effect.fail(new NativeProofFailed({}))))
        return Effect.sync(() => child.kill())
      }),
      (process) => Effect.sync(() => process.child.kill()),
    )
    return NativeProof.of({
      run: Effect.fn('Test.nativePages')(() =>
        Effect.callback<{ code: number | null; output: string }, NativeProofFailed>((resume) => {
          launched.child.once('close', (code) =>
            resume(Effect.succeed({ code, output: launched.output.text })),
          )
          launched.child.stdin.end('start')
        }),
      ),
    })
  }),
)

const available = NodeFS.existsSync('/usr/bin/xvfb-run')
if (!available) console.warn('Skipping native pages: xvfb-run is absent')
/** Native constructors, capture denial, popups and zoom are exercised in a disposable real client. */
describe.skipIf(!available)('Native desktop pages', () => {
  layer(nativeProofLayer, { excludeTestServices: true })((it) => {
    it.effect(
      'caps native guests, refuses display capture and repositions pages on menu zoom',
      () =>
        Effect.gen(function* () {
          const result = yield* (yield* NativeProof).run()
          expect(result.output).toContain('Vivid native pages proof passed')
          expect(result.code).toBe(0)
        }),
    )
  })
})
