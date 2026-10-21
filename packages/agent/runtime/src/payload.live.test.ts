import * as NodeCrypto from 'node:crypto'
import * as NodeProcess from 'node:process'
import { describe, expect, it } from '@effect/vitest'
import { defineTool, useModel, useTool } from '@flue/runtime'
import { start } from '@flue/runtime/node'
import { createAgentRouter } from '@flue/runtime/routing'
import {
  createFlueClient,
  type AgentConversationObservationSnapshot,
  type ConversationStreamChunk,
} from '@flue/sdk'
import { textOf } from '@vivid/contracts'
import { Effect, Option, Queue, Stream } from 'effect'
import * as v from 'valibot'
import { disposableStorage } from '../tests/schema.ts'
import { provider } from './providers/openrouter.ts'

const enabled = NodeProcess.env.VIVID_LIVE_RECONCILIATION === '1'
const samples = 12
const payload = 'x'.repeat(4096)

/** Request cancellation must release Hono's in-process response body before runtime shutdown. */
function fetchRuntime(router: ReturnType<typeof createAgentRouter>): typeof fetch {
  return (input, options) => {
    const request = new Request(input, options)
    request.signal.throwIfAborted()
    return Promise.resolve(router.fetch(request)).then((response) => {
      request.signal.throwIfAborted()
      if (response.body === null) return response
      return new Response(
        response.body.pipeThrough(new TransformStream(), { signal: request.signal }),
        response,
      )
    })
  }
}

/** Only tool data is controlled. OpenRouter chooses and streams every actual model step. */
const fixture = Effect.fn('LivePayload.fixture')(function* () {
  const { storage } = yield* disposableStorage
  let calls = 0
  const sample = defineTool({
    name: 'sample',
    description: 'Read the next sample. Call once at a time until all twelve are read.',
    input: v.object({}),
    /** Real tool execution supplies a distinct receipt and a fixed-size result to retain. */
    run: () => {
      calls += 1
      expect(calls).toBeLessThanOrEqual(samples)
      return { output: { step: calls, remaining: samples - calls, payload } }
    },
  })
  function Payload() {
    useModel('openrouter/z-ai/glm-5.3-flash')
    useTool(sample)
    return 'Call sample exactly twelve times, one call per model step, waiting for each result. Read only step and remaining to choose the next action; payload is opaque padding and needs no analysis. When remaining is positive, call sample immediately. When remaining is zero, stop calling tools. Then explain why rivers meander in three paragraphs, beginning with the bold heading **Why Rivers Meander**. Never repeat the sample payload in your answer.'
  }
  Payload.agentName = 'live-payload'
  Payload.durability = { maxAttempts: 1 }
  yield* Effect.acquireRelease(
    Effect.tryPromise(() => start({ agents: [Payload], providers: [provider], db: storage })),
    (runtime) => Effect.promise(() => runtime.stop()),
  )
  const id = NodeCrypto.randomUUID()
  const client = createFlueClient({
    url: `http://runtime.test/${id}`,
    fetch: fetchRuntime(createAgentRouter(Payload)),
  })
  return { client, calls: () => calls }
})

/** Count serialized public chunks, including tool payloads repeated by canonical replacements. */
function measure(chunks: readonly ConversationStreamChunk[]) {
  const replacements = chunks
    .filter((chunk) => chunk.type === 'message-appended')
    .filter((chunk) => chunk.message.role === 'assistant')
  return {
    modelSteps: chunks.filter((chunk) => chunk.type === 'message-completed').length,
    toolOutputs: chunks.filter((chunk) => chunk.type === 'tool-output').length,
    replacements: replacements.length,
    repeatedOutputs: replacements.reduce(
      (count, chunk) =>
        count +
        chunk.message.parts.filter(
          (part) => part.type === 'dynamic-tool' && part.state === 'output-available',
        ).length,
      0,
    ),
    replacementBytes: replacements.reduce(
      (bytes, chunk) => bytes + Buffer.byteLength(JSON.stringify(chunk)),
      0,
    ),
    wireBytes: chunks.reduce((bytes, chunk) => bytes + Buffer.byteLength(JSON.stringify(chunk)), 0),
    toolBytes: chunks
      .filter((chunk) => chunk.type === 'tool-output')
      .reduce((bytes, chunk) => bytes + Buffer.byteLength(JSON.stringify(chunk)), 0),
  }
}

/** Claim: a real multi-step OpenRouter reply reconciles once, before settlement, with history. */
describe.skipIf(!enabled)('OpenRouter response reconciliation', () => {
  it.live(
    'does not resend earlier tool payloads after every model step',
    () =>
      Effect.gen(function* () {
        const { client, calls } = yield* fixture()
        const receipt = yield* Effect.tryPromise(() =>
          client.send({ message: { kind: 'user', body: 'Read all twelve samples, then answer.' } }),
        )
        const states = yield* Queue.unbounded<AgentConversationObservationSnapshot>()
        const observation = yield* Effect.acquireRelease(
          Effect.sync(() => client.observe({ live: 'sse' })),
          (value) => Effect.sync(() => value.close()),
        )
        const changed = () => {
          Queue.offerUnsafe(states, observation.getSnapshot())
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => observation.subscribe(changed)),
          (unsubscribe) => Effect.sync(unsubscribe),
        )
        changed()
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (value) => Effect.sync(() => value.abort()),
        )
        const chunks: ConversationStreamChunk[] = []
        const arrived = new Map<ConversationStreamChunk, number>()
        yield* Effect.tryPromise(() =>
          client.wait(receipt, {
            signal: controller.signal,
            onEvent: (chunk) => {
              chunks.push(chunk)
              arrived.set(chunk, performance.now())
            },
          }),
        )
        const result = yield* Stream.fromQueue(states).pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.conversation !== undefined &&
              snapshot.conversation.settlements.some(
                (settled) => settled.submissionId === receipt.submissionId,
              ),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        )
        const history = yield* Effect.tryPromise(() => client.history())
        const canonical = history.messages.find(
          (message) =>
            message.role === 'assistant' && message.submissionId === receipt.submissionId,
        )
        const conversation = result.conversation
        if (canonical === undefined || conversation === undefined)
          expect.fail('The real reply must exist in observation and canonical history')
        const live = conversation.messages.find((message) => message.id === canonical.id)
        if (live === undefined) expect.fail('The live reply must retain its canonical id')
        expect(live).toEqual(canonical)
        expect(textOf(live)).toContain('Why Rivers Meander')
        expect(calls()).toBe(samples)
        const metrics = measure(chunks)
        const completed = chunks.findLast((chunk) => chunk.type === 'message-completed')
        const settled = chunks.find((chunk) => chunk.type === 'submission-settled')
        const completedAt = completed === undefined ? undefined : arrived.get(completed)
        const settledAt = settled === undefined ? undefined : arrived.get(settled)
        if (completedAt === undefined || settledAt === undefined)
          expect.fail('The actual response must complete and settle on the public wire')
        console.info(
          `reconciliation ${JSON.stringify({ ...metrics, finalSettlementGapMs: settledAt - completedAt })}`,
        )
        expect(metrics.toolOutputs).toBe(samples)
        expect(metrics.modelSteps).toBe(samples + 1)
        expect(metrics.replacements).toBe(1)
        expect(metrics.repeatedOutputs).toBe(samples)
        expect(chunks.filter((chunk) => chunk.type === 'conversation-reset')).toHaveLength(0)
        const replacement = chunks.findIndex((chunk) => chunk.type === 'message-appended')
        const settlement = chunks.findIndex((chunk) => chunk.type === 'submission-settled')
        expect(replacement).toBeGreaterThanOrEqual(0)
        expect(settlement).toBeGreaterThan(replacement)
      }).pipe(Effect.scoped),
    900_000,
  )
})
