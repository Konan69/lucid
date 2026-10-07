import { Deferred, Effect, Option } from 'effect'
import { FixtureFailed } from '../fixtures/harness.ts'
import { consumeReadable } from '../fixtures/reading.ts'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { watchEvents, type AgentEvent } from '@earendil-works/pi-durable'
import { expect, it } from '@effect/vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { continueRun, decide, holdId, streamRun } from '../main.ts'
import { streamingProvider, providerFamilies } from '../fixtures/provider.ts'
import { runForPi } from '../pi.ts'
import { context, host, texts } from './fixtures/host.ts'
/** The source-derived wrapper retains provider JSON scratch buffers alongside growing parsed arguments. */
it.live('receives raw argument JSON from the provider before the durable boundary', () =>
  Effect.gen(function* () {
    const input = { account: 'savings', amount: 100 }
    const faux = streamingProvider({ tokenSize: { min: 1, max: 1 } })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('pay', input, { id: 'wire' })], {
        stopReason: 'toolUse',
      }),
    ])
    const models = createModels()
    models.setProvider(faux.provider)
    const stream = models.streamSimple(faux.getModel(), { messages: [] })
    const deltas: string[] = []
    {
      const iterator1 = stream[Symbol.asyncIterator]()
      for (;;) {
        const next1 = yield* Effect.promise(() => iterator1.next())
        if (next1.done) break
        const event = next1.value
        if (event.type === 'toolcall_delta') deltas.push(event.delta)
      }
    }
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.join('')).toBe(JSON.stringify(input))
    expect((yield* Effect.promise(() => stream.result())).content).toEqual([
      { type: 'toolCall', id: 'wire', name: 'pay', arguments: input },
    ])
  }),
)
/**
 * Real Anthropic/OpenAI/Bedrock/Mistral partial families pass through SQLite and Pi's public watch.
 * Non-append scratch/signature edits produce block updates, never terminal client input. Drain
 * delivery through a receipt; consume validates every chunk and uses the stock SDK reader.
 */
const families = providerFamilies
for (const partialFamily of families)
  it.live(
    `approves final arguments after growing ${partialFamily} blocks and Google text signatures`,
    () =>
      Effect.gen(function* () {
        const input = { account: 'savings '.repeat(20), amount: 12345 }
        const paid: (typeof input)[] = []
        const fixture = yield* host(
          {
            pay: tool({
              inputSchema: z.object({ account: z.string(), amount: z.number() }),
              execute: (arguments_) =>
                runForPi(
                  Effect.sync(() => {
                    paid.push(arguments_)
                    return arguments_
                  }),
                  undefined,
                ),
            }),
          },
          { approval: { pay: true } },
          { progress: { partialIntervalMs: 0 } },
          { partialFamily, commitFrames: true, tokenSize: { min: 1, max: 1 } },
        )
        const opened = yield* fixture.open()
        opened.faux.setResponses([
          fauxAssistantMessage(
            [
              fauxText('Before '.repeat(20)),
              fauxToolCall('pay', input, { id: 'wire' }),
              fauxText('After '.repeat(20)),
            ],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Done.'),
        ])
        const events = yield* Effect.promise(() =>
          watchEvents(opened.harness, opened.root.id, context),
        )
        yield* Effect.addFinalizer(() => Effect.promise(() => events.stop()))
        const delivered: AgentEvent[] = []
        const receipt = yield* Deferred.make<void, FixtureFailed>()
        events.start((batch) =>
          runForPi(
            Effect.sync(() => {
              delivered.push(...batch)
              if (
                batch.some(
                  (event) =>
                    event.type === 'entry_appended' && event.entry.kind === 'arguments.receipt',
                )
              )
                Deferred.doneUnsafe(receipt, Effect.void)
            }),
            context.abortSignal,
          ),
        )
        const result = yield* consumeReadable(
          yield* Effect.promise(() =>
            streamRun(
              opened.harness,
              { conversationId: opened.root.id, content: 'Pay', requestId: 'arguments' },
              context,
            ),
          ),
          Option.none(),
        )
        yield* Effect.promise(() =>
          opened.root.commit(
            (tx) => tx.appendEntry(opened.root.id, { kind: 'arguments.receipt' }),
            context,
          ),
        )
        yield* Deferred.await(receipt)
        const changes = delivered.flatMap((event) =>
          event.type === 'message_update' ? event.changes : [],
        )
        const scratch =
          partialFamily === 'anthropic' ||
          partialFamily === 'bedrock' ||
          partialFamily === 'responses'
            ? 'partialJson'
            : 'partialArgs'
        expect(changes).toContainEqual(
          expect.objectContaining({
            type: 'block',
            contentIndex: 1,
            block: expect.objectContaining({ type: 'toolCall', [scratch]: expect.any(String) }),
          }),
        )
        const signature = changes.findIndex(
          (change) => change.type === 'block' && change.block.type === 'text',
        )
        expect(signature).toBeGreaterThanOrEqual(0)
        expect(changes.slice(signature + 1).some((change) => change.type === 'text_delta')).toBe(
          true,
        )
        expect(texts(result.message)).toEqual(['Before '.repeat(20), 'After '.repeat(20)])
        const recorded = delivered
          .flatMap((event) => (event.type === 'message_end' ? (event.entry.model ?? []) : []))
          .flatMap((message) =>
            message.role === 'assistant'
              ? message.content.filter((block) => block.type === 'toolCall')
              : [],
          )
        expect(recorded).toEqual([{ type: 'toolCall', id: 'wire', name: 'pay', arguments: input }])
        const phases = result.chunks.filter((chunk) => chunk.type.startsWith('tool-input-'))
        expect(phases[0]).toEqual({ type: 'tool-input-start', toolCallId: 'wire', toolName: 'pay' })
        expect(phases.at(-1)).toEqual({
          type: 'tool-input-available',
          toolCallId: 'wire',
          toolName: 'pay',
          input,
        })
        expect(phases.filter((chunk) => chunk.type === 'tool-input-start')).toHaveLength(1)
        expect(phases.filter((chunk) => chunk.type === 'tool-input-available')).toHaveLength(1)
        const deltas = phases.slice(1, -1)
        expect(deltas.every((chunk) => chunk.type === 'tool-input-delta')).toBe(true)
        const raw = deltas
          .flatMap((chunk) => (chunk.type === 'tool-input-delta' ? [chunk.inputTextDelta] : []))
          .join('')
        expect(raw.length).toBeGreaterThan(0)
        expect(JSON.stringify(input).startsWith(raw)).toBe(true)
        const available = result.chunks.findIndex((chunk) => chunk.type === 'tool-input-available')
        const approval = result.chunks.find((chunk) => chunk.type === 'tool-approval-request')
        if (approval === undefined) throw new Error('Expected approval')
        expect(result.chunks.indexOf(approval)).toBeGreaterThan(available)
        expect(paid).toEqual([])
        yield* Effect.promise(() =>
          decide(
            opened.harness,
            opened.root.id,
            { holdId: holdId(approval.approvalId), approved: true },
            context,
          ),
        )
        yield* consumeReadable(
          yield* Effect.promise(() =>
            continueRun(
              opened.harness,
              opened.root.id,
              { messageId: result.message.id, known: new Set(['wire']) },
              context,
            ),
          ),
          Option.some(result.message),
        )
        expect(paid).toEqual([input])
      }),
  )
