import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { tool } from 'ai'
import { z } from 'zod'
import { toolsExtension, waiting } from '../main.ts'
import { call, context, host, modelText } from './fixtures/host.ts'

/** A reader is deliberately absent: presentation checks cannot protect the executing registration. */
it.live('blocks a gated duplicate after an ungated owner pins Free', () =>
  Effect.gen(function* () {
    const executions: string[] = []
    const first = yield* Effect.promise(() =>
      toolsExtension('first', {
        pay: tool({
          inputSchema: z.object({}),
          execute: () => {
            executions.push('first')
            return Promise.resolve('first')
          },
        }),
      }),
    )
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({}),
          needsApproval: true,
          execute: () => {
            executions.push('gated')
            return Promise.resolve('paid')
          },
        }),
      },
      {},
    )
    const opened = yield* fixture.open([first])
    let modelRead = ''
    opened.faux.setResponses([
      call('pay', {}, 'pay'),
      (request) => {
        modelRead = modelText(request.messages)
        return fauxAssistantMessage('Blocked.')
      },
    ])
    yield* Effect.promise(() => opened.root.submit({ type: 'input', content: 'Pay' }, context))
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(executions).toEqual([])
    expect(modelRead).toContain('tool names must be unique across extensions')
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
  }),
)

/** Pi replaces equal extension names; a factory cannot detect an extension the registry discarded. */
it.live('Pi replaces the earlier bridged extension with the same extension name', () =>
  Effect.gen(function* () {
    const executions: string[] = []
    const first = yield* Effect.promise(() =>
      toolsExtension('conformance', {
        pay: tool({
          inputSchema: z.object({}),
          needsApproval: true,
          execute: () => {
            executions.push('discarded')
            return Promise.resolve('discarded')
          },
        }),
      }),
    )
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({}),
          execute: () => {
            executions.push('replacement')
            return Promise.resolve('paid')
          },
        }),
      },
      {},
    )
    const opened = yield* fixture.open([first])
    expect(
      (yield* Effect.promise(() => opened.root.agent(context))).extensions.map(
        (extension) => extension.name,
      ),
    ).toEqual(['conformance'])
    opened.faux.setResponses([call('pay', {}, 'pay'), fauxAssistantMessage('Paid.')])
    yield* Effect.promise(() => opened.root.submit({ type: 'input', content: 'Pay' }, context))
    yield* Effect.promise(() => opened.root.waitForIdle(context))
    expect(executions).toEqual(['replacement'])
    expect(yield* Effect.promise(() => waiting(opened.harness, opened.root.id, context))).toEqual(
      [],
    )
  }),
)
