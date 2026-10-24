import { NodeServices } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import * as NodeURL from 'node:url'
import { Effect, Option, Stream } from 'effect'
import { ChildProcess } from 'effect/process'

/** Isolated, scoped Node processes prove import-time opt-in without sharing Flue's registry.
 * Await exit and both output streams, so completion includes native pipe close. Cancellation
 * closes the process scope. Vite closes on import failure too, instead of retaining watchers. */
const registration = Effect.fn('RehearsalTest.registration')(function* (
  model: Option.Option<string>,
) {
  const env = { ...process.env }
  delete env.VIVID_MODEL
  if (Option.isSome(model)) env.VIVID_MODEL = model.value
  const module = NodeURL.fileURLToPath(new URL('../rehearsal.ts', import.meta.url))
  const code = `import { createServer } from 'vite';
    import { hasProvider, resolveModel } from '@flue/runtime/internal';
    const bundler = await createServer({ configFile: false, logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, watch: null } });
    try {
      await bundler.ssrLoadModule(${JSON.stringify(module)});
      console.log(JSON.stringify({ registered: hasProvider('rehearsal'), model: hasProvider('rehearsal') ? resolveModel('rehearsal/script').id : null }));
    } finally {
      await bundler.close();
    }`
  const child = yield* ChildProcess.make(process.execPath, ['--input-type=module', '-e', code], {
    cwd: NodeURL.fileURLToPath(new URL('../../../', import.meta.url)),
    env,
  })
  const [status, stdout, stderr] = yield* Effect.all(
    [
      child.exitCode,
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
      child.stderr.pipe(Stream.decodeText, Stream.mkString),
    ],
    { concurrency: 3 },
  )
  expect(status, stderr).toBe(0)
  return stdout.trim()
})

layer(NodeServices.layer, { excludeTestServices: true })('Rehearsal scenes', (it) => {
  it.effect.each([
    Option.none<string>(),
    Option.some('openrouter/z-ai/glm-5.3-flash'),
    Option.some('rehearsalish/script'),
  ])('does not register without explicit opt-in for %s', (model) =>
    Effect.gen(function* () {
      expect(yield* registration(model)).toBe('{"registered":false,"model":null}')
    }),
  )
  it.effect('registers exactly the opt-in script model through Flue', () =>
    Effect.gen(function* () {
      expect(yield* registration(Option.some('rehearsal/script'))).toBe(
        '{"registered":true,"model":"script"}',
      )
    }),
  )
})
