import * as NodeEvents from 'node:events'
import * as NodeFSP from 'node:fs/promises'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Message, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  Harness,
  type HarnessSettings,
  type Extension,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
  DefaultChatTransport,
  readUIMessageStream,
  uiMessageChunkSchema,
  tool,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { onTestFinished } from 'vitest'
import { Effect, Option, Stream } from 'effect'
import { runForPi, watchLive } from '../../pi.ts'
import { waitForFrame } from '../../fixtures/provider.ts'
import { z } from 'zod'

import { respond, toolsExtension, waiting, type ToolsOptions } from '../../main.ts'
import { streamingProvider, type ProviderOptions } from '../../fixtures/provider.ts'

export const context = BACKGROUND_CONTEXT

/** Return a typed signal on the package's ES2023 baseline, without clock-based coordination. */
export function signal() {
  const events = new NodeEvents.EventEmitter<{ settled: []; error: [Error] }>()
  const promise = NodeEvents.EventEmitter.once(events, 'settled').then(() => {})
  return {
    promise,
    resolve: () => {
      events.emit('settled')
    },
    reject: (error: Error) => {
      events.emit('error', error)
    },
  }
}

/** The actual Pi messages presented to the faux model, without reading bridge internals. */
export function modelText(messages: readonly Message[]) {
  return messages
    .flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
        : [message.content],
    )
    .join('\n')
}

/** Script a complete model tool round with stable call ids for decisions and replay. */
export function call(name: string, input: Record<string, string | number>, id: string) {
  return fauxAssistantMessage([fauxToolCall(name, input, { id })], { stopReason: 'toolUse' })
}

/**
 * Collect and fold using the unmodified AI SDK consumer, including continuations.
 * AI SDK packages/ai/src/ui-message-stream/ui-message-chunks.test.ts: returns UI message chunks.
 * Validate every emitted chunk with the SDK's public schema; type annotations are no wire proof.
 */
export async function consume(stream: ReadableStream<UIMessageChunk>, from?: UIMessage) {
  const [raw, folded] = stream.tee()
  const chunks: UIMessageChunk[] = []
  const collecting = (async () => {
    const schema = uiMessageChunkSchema()
    if (schema.validate === undefined) throw new Error('Expected the SDK chunk validator')
    for await (const chunk of raw) {
      const checked = await schema.validate(chunk)
      if (!checked.success) throw checked.error
      chunks.push(checked.value)
    }
  })()
  let message = from
  const reading = from === undefined ? { stream: folded } : { stream: folded, message: from }
  for await (const next of readUIMessageStream(reading)) message = next
  await collecting
  if (message === undefined) throw new Error('Expected an assistant message')
  return { chunks, message }
}

/** Text parts, kept separate so duplicate parts cannot be concealed by concatenation. */
export function texts(message: UIMessage) {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
}

/**
 * Adapt recovery.test.ts and holds.test.ts to disposable SQLite and the public bridge only.
 * Cleanup is registered before opening storage; a failed assertion still closes every harness.
 * Reopening builds fresh volatile models and registries, preserving only Pi's database.
 */
export async function host(
  tools: ToolSet,
  options: ToolsOptions,
  settings: Partial<HarnessSettings> = {},
  fauxOptions: ProviderOptions & { readonly commitFrames?: boolean } = {},
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-conformance-'))
  const file = NodePath.join(directory, 'session.sqlite')
  const opened = new Set<Harness>()
  onTestFinished(async () => {
    try {
      for (const harness of opened) await harness.close(context)
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true })
    }
  })
  /** Open a fresh process-equivalent host on the same durable transcript. */
  async function open(observers: readonly Extension[] = []) {
    const { commitFrames = false, onFrame = () => Effect.void, ...providerOptions } = fauxOptions
    let owner: Option.Option<{ harness: Harness; id: Parameters<typeof respond>[1] }> =
      Option.none()
    let frames = 0
    /** A bounded number of meaningful prefixes cross the real SQLite commit before generation
     * advances. No token-rate clock: progress is released by the public LiveDoc receipt. */
    const committed = (event: AssistantMessageEvent, abortSignal: Option.Option<AbortSignal>) => {
      if (!commitFrames || event.type === 'done' || event.type === 'error') return Effect.void
      frames++
      if (event.partial.content.length === 0 || (frames % 16 !== 0 && event.type !== 'text_delta'))
        return Effect.void
      if (Option.isNone(owner)) throw new Error('Provider invoked before its host opened')
      const { harness, id } = owner.value
      const expected = JSON.stringify(event.partial)
      return Effect.promise(() =>
        runForPi(
          waitForFrame(
            Effect.scoped(
              Effect.gen(function* () {
                const states = yield* watchLive(harness, id, context)
                yield* Stream.runHead(
                  states.pipe(
                    Stream.filter(
                      (live) =>
                        live.generation !== undefined &&
                        JSON.stringify(live.generation.message) === expected,
                    ),
                  ),
                )
              }),
            ),
            abortSignal,
          ),
          undefined,
        ),
      )
    }
    const faux = streamingProvider({
      ...providerOptions,
      onFrame: (event, abortSignal) =>
        committed(event, abortSignal).pipe(Effect.andThen(onFrame(event, abortSignal))),
    })
    const models = createModels()
    models.setProvider(faux.provider)
    const registry = createRegistry()
    for (const extension of observers) registry.install(extension)
    registry.install(await toolsExtension('conformance', tools, options))
    const storage = await openNodeSqliteStorage(file)
    onTestFinished(() => storage.close(context))
    const harness = await Harness.open(
      storage,
      { models, registry, settings: { retry: { baseDelayMs: 0 }, ...settings } },
      context,
    )
    opened.add(harness)
    const root = await harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    })
    owner = Option.some({ harness, id: root.id })
    const transport = new DefaultChatTransport<UIMessage>({
      api: 'http://durable.test/chat',
      fetch: async (url, init) => respond(harness, root.id, new Request(url, init), context),
    })
    return { harness, root, faux, transport }
  }
  /** Model a clean host shutdown without leaving stale volatile state in restart assertions. */
  async function close(harness: Harness) {
    await harness.close(context)
    opened.delete(harness)
  }
  return { open, close, file }
}

/** Approval and person-answered tools shared by the HITL and actual SDK consumer suites. */
export async function shop(settings: Partial<HarnessSettings> = {}) {
  const paid: number[] = []
  const fixture = await host(
    {
      pay: tool({
        description: 'Pay an invoice',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => {
          paid.push(amount)
          return { receipt: amount }
        },
      }),
      ask: tool({ description: 'Ask a person', inputSchema: z.object({ question: z.string() }) }),
      later: tool({
        description: 'Ask a person later',
        inputSchema: z.object({ question: z.string() }),
      }),
    },
    { approval: { pay: true }, answers: { later: 'later' } },
    settings,
  )
  return { ...fixture, paid }
}

/** Resolve the public task identity from an actual waiting row, never from a provider call id. */
export async function hold(
  harness: Harness,
  conversationId: Parameters<typeof waiting>[1],
  callId: string,
) {
  const rows = (await waiting(harness, conversationId, context)).filter(
    (row) => row.callId === callId,
  )
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(`Expected one waiting ${callId}`)
  return rows[0].holdId
}
