import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import { tool } from 'ai'
import { z } from 'zod'
import { prepareRun } from '../core.ts'
import { respond, toolsExtension, ToolNameDuplicated } from '../main.ts'
import { context, host } from './fixtures/host.ts'

/** A duplicate bridged registration is a host configuration failure, not a Pi adapter rejection.
 * It must reject the original tag and produce HTTP 500 before committing a Person's turn. */
it.live('duplicate tool names preserve their tag and refuse POST before opening a stream', () =>
  Effect.gen(function* () {
    const tools = {
      pay: tool({ inputSchema: z.object({}), execute: () => Promise.resolve('paid') }),
    }
    const fixture = yield* host(tools, {})
    const extension = yield* Effect.promise(() =>
      toolsExtension('other', tools, { approval: { pay: true } }),
    )
    const opened = yield* fixture.open([extension])
    opened.faux.setResponses([fauxAssistantMessage('Unused.')])
    const refused = yield* prepareRun(
      opened.harness,
      {
        conversationId: opened.root.id,
        requestId: 'core',
        content: 'Pay',
      },
      context,
    ).pipe(Effect.flatMap(Stream.runDrain), Effect.flip)
    expect(refused).toBeInstanceOf(ToolNameDuplicated)
    expect(refused).toMatchObject({ toolName: 'pay' })
    const response = yield* Effect.promise(() =>
      respond(
        opened.harness,
        opened.root.id,
        new Request('http://durable.test/chat', {
          method: 'POST',
          body: JSON.stringify({
            messages: [{ id: 'post', role: 'user', parts: [{ type: 'text', text: 'Pay' }] }],
          }),
        }),
        context,
      ),
    )
    expect(response.status).toBe(500)
    expect(yield* Effect.promise(() => response.text())).toBe(refused.message)
    expect(opened.faux.state.callCount).toBe(0)
    expect(
      (yield* Effect.promise(() => opened.root.entries({}, 100, undefined, context))).items.filter(
        (entry) => entry.kind === 'pi.user',
      ),
    ).toEqual([])
  }),
)
