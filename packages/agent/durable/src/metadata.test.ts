import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'

import { context, host } from './conformance/fixtures/host.ts'
import { emptyMetadata, messageMetadata, recordMetadata } from './metadata.ts'

/** Use real Pi entries for their branded identity, then supply owned provider copies at the
 * metadata ingress. Pi's strict-JSON writer cannot persist NaN/Infinity, so malformed counts must
 * be exercised here rather than by pretending they reached the persisted transcript. */
it.live('omits a response with any non-finite token count and preserves other responses', () =>
  Effect.gen(function* () {
    const fixture = yield* host({}, {})
    const opened = yield* fixture.open()
    opened.faux.setResponses([
      fauxAssistantMessage('First response.'),
      fauxAssistantMessage('Second response.'),
    ])
    for (const content of ['First', 'Second']) {
      yield* Effect.promise(() => opened.root.submit({ type: 'input', content }, context))
      yield* Effect.promise(() => opened.root.waitForIdle(context))
    }
    const page = yield* Effect.promise(() => opened.root.entries({}, 100, undefined, context))
    const entries = page.items.toReversed().filter((entry) => entry.kind === 'pi.assistant')
    const first = entries[0]
    const second = entries[1]
    if (first === undefined || second === undefined || first.model === undefined)
      throw new Error('Expected two recorded provider responses')
    const message = first.model.find((item) => item.role === 'assistant')
    if (message === undefined) throw new Error('Expected first provider message')
    const finite = recordMetadata(emptyMetadata, second)
    const expected = messageMetadata(finite, Option.none())
    for (const key of [
      'input',
      'output',
      'cacheRead',
      'cacheWrite',
      'totalTokens',
      'cacheWrite1h',
      'reasoning',
    ] as const) {
      for (const count of [NaN, Infinity, -Infinity]) {
        const malformed = {
          ...first,
          model: [{ ...message, usage: { ...message.usage, [key]: count } }],
        }
        const omitted = recordMetadata(emptyMetadata, malformed)
        expect(recordMetadata(omitted, malformed)).toBe(omitted)
        expect(messageMetadata(omitted, Option.none())).toEqual({
          models: [{ provider: message.provider, modelId: message.model }],
        })
        expect(messageMetadata(recordMetadata(omitted, second), Option.none())).toEqual(expected)
      }
    }
    expect(recordMetadata(finite, second)).toBe(finite)
  }),
)
