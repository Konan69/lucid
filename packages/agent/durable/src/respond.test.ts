import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { decodeTurn, respond, TurnInvalid } from './core.ts'
import { memory } from './fixtures/harness.ts'
import { consume } from './fixtures/reading.ts'

const context = BACKGROUND_CONTEXT

/** Decode real chat input, stream it, and verify that Pi also persisted the user contribution. */
it.live('answers a decoded chat turn and retains the user input', () =>
  Effect.gen(function* () {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage('Paris.')])
    const harness = yield* memory(models, createRegistry())
    const root = yield* Effect.promise(() =>
      harness.root(context, {
        agent: { model: { provider: 'faux', modelId: 'faux-1' } },
      }),
    )
    const turn = yield* decodeTurn({
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Capital of France?' }] }],
    }).pipe(Effect.mapError(() => new TurnInvalid({})))
    const stream = yield* respond(harness, root.id, turn, context)
    const { message } = yield* consume(stream, Option.none())
    expect(message.parts.at(-1)).toMatchObject({ type: 'text', text: 'Paris.', state: 'done' })
    const entries = yield* Effect.promise(() => root.entries({}, 10, undefined, context))
    expect([...entries.items].map((entry) => entry.kind)).toContain('pi.user')
  }),
)
