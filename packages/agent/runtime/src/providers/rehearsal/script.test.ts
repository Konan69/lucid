import { describe, expect, it } from '@effect/vitest'
import * as NodeChildProcess from 'node:child_process'
import { Option } from 'effect'

/**
 * Each registration case starts a Node process that boots Vite and loads the provider cold: about
 * two seconds on an idle machine, and past the default five when several gates share its cores
 * (6.6 s and 16 s measured on the Cloudbox, 6 Oct 2026). This is a ceiling for that start, not a
 * wait: nothing here sleeps.
 */
const coldProcess = 30_000

/** Isolated Node processes prove import-time opt-in against Flue's real registry without module mocks or global env changes. */
function registration(model: Option.Option<string>) {
  const env = { ...process.env }
  delete env.VIVID_MODEL
  if (Option.isSome(model)) env.VIVID_MODEL = model.value
  const module = new URL('../rehearsal.ts', import.meta.url).href
  const code = `import { createServer } from 'vite';
    import { hasProvider, resolveModel } from '@flue/runtime/internal';
    const bundler = await createServer({ configFile: false, logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, watch: null } });
    await bundler.ssrLoadModule(${JSON.stringify(module.replace('file://', ''))});
    console.log(JSON.stringify({ registered: hasProvider('rehearsal'), model: hasProvider('rehearsal') ? resolveModel('rehearsal/script').id : null }));
    await bundler.close();`
  const result = NodeChildProcess.spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: new URL('../../../', import.meta.url),
    env,
    encoding: 'utf8',
    timeout: coldProcess,
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

describe('Rehearsal scenes', () => {
  it(
    'does not register without explicit opt-in for absent, unrelated or similarly named models',
    () => {
      for (const model of [
        Option.none<string>(),
        Option.some('openrouter/z-ai/glm-5.3-flash'),
        Option.some('rehearsalish/script'),
      ]) {
        expect(
          registration(model),
          Option.getOrElse(model, () => 'no model'),
        ).toBe('{"registered":false,"model":null}')
      }
    },
    coldProcess * 3,
  )
  it(
    'registers exactly the opt-in script model through Flue',
    () => {
      expect(registration(Option.some('rehearsal/script'))).toBe(
        '{"registered":true,"model":"script"}',
      )
    },
    coldProcess,
  )
})
