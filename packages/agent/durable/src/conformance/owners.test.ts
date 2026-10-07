import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { tool } from 'ai'
import { z } from 'zod'
import { toolsExtension, waiting } from '../main.ts'
import { call, context, host, modelText } from './fixtures/host.ts'

/** A reader is deliberately absent: presentation checks cannot protect the executing registration. */
it.live('blocks a gated duplicate after an ungated owner pins Free', () =>
  Effect.promise(async () => {
    const executions: string[] = []
    const first = await toolsExtension('first', {
      pay: tool({
        inputSchema: z.object({}),
        execute: async () => {
          executions.push('first')
          return 'first'
        },
      }),
    })
    const fixture = await host(
      {
        pay: tool({
          inputSchema: z.object({}),
          needsApproval: true,
          execute: async () => {
            executions.push('gated')
            return 'paid'
          },
        }),
      },
      {},
    )
    const opened = await fixture.open([first])
    let modelRead = ''
    opened.faux.setResponses([
      call('pay', {}, 'pay'),
      (request) => {
        modelRead = modelText(request.messages)
        return fauxAssistantMessage('Blocked.')
      },
    ])
    await opened.root.submit({ type: 'input', content: 'Pay' }, context)
    await opened.root.waitForIdle(context)
    expect(executions).toEqual([])
    expect(modelRead).toContain('tool names must be unique across extensions')
    expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  }),
)

/** Pi replaces equal extension names; a factory cannot detect an extension the registry discarded. */
it.live('Pi replaces the earlier bridged extension with the same extension name', () =>
  Effect.promise(async () => {
    const executions: string[] = []
    const first = await toolsExtension('conformance', {
      pay: tool({
        inputSchema: z.object({}),
        needsApproval: true,
        execute: async () => {
          executions.push('discarded')
          return 'discarded'
        },
      }),
    })
    const fixture = await host(
      {
        pay: tool({
          inputSchema: z.object({}),
          execute: async () => {
            executions.push('replacement')
            return 'paid'
          },
        }),
      },
      {},
    )
    const opened = await fixture.open([first])
    expect(
      (await opened.root.agent(context)).extensions.map((extension) => extension.name),
    ).toEqual(['conformance'])
    opened.faux.setResponses([call('pay', {}, 'pay'), fauxAssistantMessage('Paid.')])
    await opened.root.submit({ type: 'input', content: 'Pay' }, context)
    await opened.root.waitForIdle(context)
    expect(executions).toEqual(['replacement'])
    expect(await waiting(opened.harness, opened.root.id, context)).toEqual([])
  }),
)
