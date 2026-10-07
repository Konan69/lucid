import { Deferred, Effect, Option, Predicate } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses, tool } from 'ai'
import { expect, it } from '@effect/vitest'
import { z } from 'zod'
import { PlainChat } from '../fixtures/chat.ts'
import { ToolApprovalUnsupported, toolsExtension } from '../main.ts'
import { call, context, host, texts } from './fixtures/host.ts'
/** Stock Chat must park, echo the durable approval identity, and automatically post the decision. */
for (const sample of [
  {
    name: 'boolean approval',
    declaration: true,
    amount: 5,
    held: true,
    approved: true,
    options: {},
  },
  {
    name: 'boolean denial',
    declaration: true,
    amount: 5,
    held: true,
    approved: false,
    options: {},
  },
  {
    name: 'pure function holds',
    declaration: ({ amount }: { amount: number }) => amount > 3,
    amount: 5,
    held: true,
    approved: true,
    options: {},
  },
  {
    name: 'pure function executes',
    declaration: ({ amount }: { amount: number }) => amount > 3,
    amount: 1,
    held: false,
    approved: true,
    options: {},
  },
  {
    name: 'host false overrides tool true',
    declaration: true,
    amount: 5,
    held: false,
    approved: true,
    options: { approval: { pay: false } },
  },
  {
    name: 'host true overrides tool false',
    declaration: false,
    amount: 5,
    held: true,
    approved: true,
    options: { approval: { pay: true } },
  },
  {
    name: 'host overrides asynchronous tool policy',
    // @effect-diagnostics-next-line asyncFunction:off -- subject: host override must bypass a native async approval predicate
    declaration: async () => true,
    amount: 5,
    held: false,
    approved: true,
    options: { approval: { pay: false } },
  },
])
  it.live(`honours ${sample.name} through stock SDK Chat`, () =>
    Effect.gen(function* () {
      const executions: number[] = []
      const observed: number[] = []
      const declaration = sample.declaration
      const needsApproval = Predicate.isFunction(declaration)
        ? (input: { amount: number }) => {
            observed.push(input.amount)
            return declaration(input)
          }
        : declaration
      const fixture = yield* host(
        {
          pay: tool({
            inputSchema: z.object({ amount: z.number().transform((value) => value * 2) }),
            needsApproval,
            execute: ({ amount }) => {
              executions.push(amount)
              return Promise.resolve({ receipt: amount })
            },
          }),
        },
        sample.options,
      )
      const opened = yield* fixture.open()
      opened.faux.setResponses([
        call('pay', { amount: sample.amount }, 'pay'),
        fauxAssistantMessage('Resolved.'),
      ])
      let completion = yield* Deferred.make<void, FixtureFailed>()
      const chat = new PlainChat({
        transport: opened.transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
        onFinish: () => Deferred.doneUnsafe(completion, Effect.void),
        onError: (error) =>
          Deferred.doneUnsafe(completion, Effect.fail(new FixtureFailed({ cause: error }))),
      })
      yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
      if (chat.lastMessage === undefined) throw new Error('Expected assistant message')
      const held = chat.lastMessage.parts.find(
        (part) => isToolUIPart(part) && part.toolCallId === 'pay',
      )
      if (sample.held) {
        expect(executions).toEqual([])
        if (held === undefined || !isToolUIPart(held) || held.state !== 'approval-requested')
          throw new Error('Expected approval request')
        completion = yield* Deferred.make<void, FixtureFailed>()
        yield* Effect.promise(() =>
          Promise.resolve(
            chat.addToolApprovalResponse({
              id: held.approval.id,
              approved: sample.approved,
              reason: 'Budget decision',
            }),
          ),
        )
        yield* Deferred.await(completion)
      } else expect(held).toMatchObject({ state: 'output-available' })
      expect(chat.status).toBe('ready')
      expect(executions).toEqual(sample.approved ? [sample.amount * 2] : [])
      expect(texts(chat.lastMessage)).toEqual(['Resolved.'])
      if ('approval' in sample.options) expect(observed).toEqual([])
      else expect(observed.every((amount) => amount === sample.amount * 2)).toBe(true)
    }),
  )
/** Async declarations can be rejected before any call; evaluating them is never needed at registration. */
it.live('rejects an async needsApproval declaration with a named tagged error', () =>
  Effect.gen(function* () {
    const registration = toolsExtension('async', {
      pay: tool({
        inputSchema: z.object({}),
        // @effect-diagnostics-next-line asyncFunction:off -- subject: registration must refuse a native async approval predicate
        needsApproval: async () => true,
        execute: () => Promise.resolve('paid'),
      }),
    })
    yield* Effect.map(
      Effect.flip(
        Effect.tryPromise({
          try: () => registration,
          catch: (cause) => new FixtureFailed({ cause }),
        }),
      ),
      (failed) => expect(failed.cause).toBeInstanceOf(ToolApprovalUnsupported),
    )
    yield* Effect.map(
      Effect.flip(
        Effect.tryPromise({
          try: () => registration,
          catch: (cause) => new FixtureFailed({ cause }),
        }),
      ),
      (failed) =>
        expect(failed.cause).toMatchObject({
          toolName: 'pay',
          message: expect.stringContaining('asynchronous approval function is not supported'),
        }),
    )
  }),
)
/** A regular function returning a Promise fails synchronously at the public plan, never a truthy hold. */
it.live('rejects a Promise-returning approval predicate at the call', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({}),
          needsApproval: () => Promise.resolve(true),
          execute: () => Promise.resolve('paid'),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('pay', {}, 'pay'), fauxAssistantMessage('Recovered.')])
    const chat = new PlainChat({
      transport: opened.transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
    expect(chat.status).toBe('ready')
    expect(
      Option.fromNullishOr(chat.lastMessage).pipe(
        Option.map((message) => message.parts.find(isToolUIPart)),
        Option.getOrUndefined,
      ),
    ).toMatchObject({
      state: 'output-error',
      errorText: expect.stringContaining('asynchronous approval function is not supported'),
    })
    yield* Effect.promise(() => opened.root.waitForIdle(context))
  }),
)
/** Only input-based SDK approval functions fit Plan's replay/presentation contract today. */
it.live('refuses unavailable SDK approval context rather than inventing call identity', () =>
  Effect.gen(function* () {
    const fixture = yield* host(
      {
        pay: tool({
          inputSchema: z.object({}),
          needsApproval: (_input, options) => options.toolCallId.length > 0,
          execute: () => Promise.resolve('paid'),
        }),
      },
      {},
    )
    const opened = yield* fixture.open()
    opened.faux.setResponses([call('pay', {}, 'pay'), fauxAssistantMessage('Recovered.')])
    const chat = new PlainChat({ transport: opened.transport })
    yield* Effect.promise(() => chat.sendMessage({ text: 'Pay' }))
    expect(chat.status).toBe('ready')
    expect(
      Option.fromNullishOr(chat.lastMessage).pipe(
        Option.map((message) => message.parts.find(isToolUIPart)),
        Option.getOrUndefined,
      ),
    ).toMatchObject({
      state: 'output-error',
      errorText: expect.stringContaining('toolCallId'),
    })
    yield* Effect.promise(() => opened.root.waitForIdle(context))
  }),
)
