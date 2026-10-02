import * as NodeChildProcess from 'node:child_process'
import * as NodeURL from 'node:url'
import * as NodeFS from 'node:fs'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodeProcess from 'node:process'
import { describe, expect, layer } from '@effect/vitest'
import { Context, Effect, Layer, Schema, Option } from 'effect'
import * as Esbuild from 'esbuild'
import electron from 'electron'

// Electron's Node entry returns its executable path; its browser declaration describes the API.
const electronExecutable = Schema.decodeUnknownSync(Schema.String)(electron)

class NativeProofFailed extends Schema.TaggedError<NativeProofFailed>()(
  'NativeProofFailed',
  {},
  { title: 'Native page proof failed' },
) {}
/** A completed native process group needs no further shutdown. */
class NativeProcessGone extends Schema.TaggedError<NativeProcessGone>()(
  'NativeProcessGone',
  {},
  { title: 'Native proof process is already stopped' },
) {}
const missingProcess = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.Literal('ESRCH') }))

/**
 * detached:true creates an isolated group for this exact spawned PID. Stop only that captured group,
 * including Electron and Xvfb; killing the wrapper alone can leave its children holding pipe handles.
 */
const stopNative = Effect.fn('NativePages.stop')(function* (
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
) {
  const pid = child.pid
  if (pid === undefined) return
  yield* Effect.try({
    try: () => NodeProcess.kill(-pid, 'SIGTERM'),
    catch: (cause) =>
      Option.isSome(missingProcess(cause)) ? new NativeProcessGone({}) : new NativeProofFailed({}),
  }).pipe(
    Effect.catchTag('NativeProcessGone', () => Effect.void),
    Effect.catchTag('NativeProofFailed', (failure) => Effect.die(failure)),
  )
})

interface NativeProofService {
  readonly run: () => Effect.Effect<{ output: string }, NativeProofFailed>
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
    const preload = `${directory}/preload.cjs`
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
    yield* Effect.tryPromise({
      try: () =>
        Esbuild.build({
          entryPoints: [NodeURL.fileURLToPath(new URL('../preload/main.ts', import.meta.url))],
          bundle: true,
          platform: 'node',
          format: 'cjs',
          external: ['electron'],
          outfile: preload,
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
          ['-a', electronExecutable, executable, `${directory}/profile`, preload],
          { stdio: 'pipe', detached: true },
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
        return stopNative(child)
      }),
      (process) =>
        Effect.gen(function* () {
          if (!process.output.text.includes('Vivid native pages proof passed'))
            console.error(process.output.text)
          const stopped = Effect.callback<void>((resume) => {
            if (process.child.exitCode !== null || process.child.signalCode !== null)
              return resume(Effect.void)
            process.child.once('exit', () => resume(Effect.void))
          })
          yield* stopNative(process.child)
          yield* stopped
        }),
    )
    return NativeProof.of({
      run: Effect.fn('Test.nativePages')(() =>
        Effect.callback<{ output: string }, NativeProofFailed>((resume) => {
          const receipt = (): void => {
            if (launched.output.text.includes('Vivid native pages proof passed'))
              resume(Effect.succeed({ output: launched.output.text }))
          }
          const exited = (): void => resume(Effect.fail(new NativeProofFailed({})))
          launched.child.stdout.on('data', receipt)
          launched.child.once('exit', exited)
          launched.child.stdin.end('start')
          return Effect.sync(() => {
            launched.child.stdout.removeListener('data', receipt)
            launched.child.removeListener('exit', exited)
          })
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
      'retains views, revokes stale geometry, routes popups and zoom, and caps native guests',
      () =>
        Effect.gen(function* () {
          const result = yield* (yield* NativeProof).run()
          expect(result.output).toContain('Vivid native pages proof passed')
        }),
    )
  })
})
