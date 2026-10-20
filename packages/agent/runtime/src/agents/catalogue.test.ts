import { describe, expect, it } from '@effect/vitest'
import { Array as Arr, Effect } from 'effect'
import { vi } from 'vitest'
import { init } from '@flue/runtime'
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai'
import { sqlite, start } from '@flue/runtime/node'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { manifest } from '@vivid/skills'
import { Vivid } from './vivid.ts'

/** Check the actual model boundary after Vivid's hooks render, including every tool prerequisite. */
const observeCatalogue: FauxResponseFactory = (context) => {
  const prompt = getCurrentSystemPrompt(context.messages)
  const mounted = [...prompt.matchAll(/^- \*\*([a-z0-9-]+)\*\*/gmu)].map((match) => match[1])
  expect(mounted).toEqual(manifest.map((entry) => entry.runtimeName))
  const tools = getCurrentTools(context.messages)
  expect(prompt).toContain('Saved procedures are unavailable right now')
  expect(prompt).not.toContain('builtin:')
  expect(prompt).not.toContain('metadata.provenance')
  expect(JSON.stringify(context.messages)).not.toContain('is no longer available')
  const registered = new Set(tools.map((tool) => tool.name))
  for (const entry of manifest) {
    for (const needed of entry.needs)
      expect(registered.has(needed), `${entry.runtimeName}: ${needed}`).toBe(true)
  }
  return fauxAssistantMessage(fauxToolCall('activate_skill', { name: 'deep-research' }))
}

/** Native activation must return the packaged procedure, not a custom RPC read or metadata. */
const observeActivation: FauxResponseFactory = (context) => {
  const result = Arr.reverse(context.messages).find((message) => message.role === 'toolResult')
  if (result === undefined || result.role !== 'toolResult')
    expect.fail('Expected native activation result')
  expect(result.toolName).toBe('activate_skill')
  const content = JSON.stringify(result.content)
  expect(content).toContain('Restate the question')
  expect(content).not.toContain('metadata')
  expect(content).not.toContain('builtin:')
  return fauxAssistantMessage('Ready.')
}

/** Public start() has no HTTP surface. Explicit in-memory SQLite isolates Flue persistence;
 * no product database, external model, runtime .state or night service is used. */
const runtimeFixture = Effect.fn('NativeSkillsTest.runtime')(function* () {
  yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()))
  vi.stubEnv('VIVID_MODEL', 'skills-test/check')
  const faux = fauxProvider({
    provider: 'skills-test',
    models: [{ id: 'check', name: 'Skills check' }],
  })
  faux.setResponses([observeCatalogue, observeActivation, observeCatalogue, observeActivation])
  yield* Effect.acquireRelease(
    Effect.promise(() =>
      start({ agents: [Vivid], db: sqlite(':memory:'), providers: [faux.provider], env: {} }),
    ),
    (runtime) => Effect.promise(() => runtime.stop()),
  )
  return init(Vivid, { id: 'native-skills-test' })
})

/**
 * The built-in skills as Vivid mounts them, through the real runtime. The skills package checks
 * its own folders and imports (`packages/agent/skills/src/native.test.ts`); what the model is shown
 * and can activate is the runtime's, so it is proved here.
 */
describe('native built-in mounts', () => {
  it.live(
    'renders Vivid with all built-in skills even without prepared summaries, then activates natively',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* runtimeFixture()
          for (const request of ['Inspect research.', 'Inspect research again.']) {
            const receipt = yield* Effect.promise(() => handle.dispatch(request))
            const reply = yield* Effect.promise(() => handle.read(receipt))
            expect(reply.text).toBe('Ready.')
          }
        }),
      ),
  )
})
