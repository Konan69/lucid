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
  type Conversation,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { DefaultChatTransport, tool, type ToolSet, type UIMessage } from 'ai'
import { Effect, Exit, Option, Scope, Stream } from 'effect'
import { runForPi, watchLive } from '../../pi.ts'
import { waitForFrame } from '../../fixtures/provider.ts'
import { z } from 'zod'

import { respond, toolsExtension, type ToolsOptions } from '../../main.ts'
import { streamingProvider, type ProviderOptions } from '../../fixtures/provider.ts'

import { FixtureFailed } from '../../fixtures/harness.ts'

export const context = BACKGROUND_CONTEXT

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

/** Text parts, kept separate so duplicate parts cannot be concealed by concatenation. */
export function texts(message: UIMessage) {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
}

export type Opened = {
  readonly harness: Harness
  readonly root: Conversation
  readonly faux: ReturnType<typeof streamingProvider>
  readonly transport: DefaultChatTransport<UIMessage>
}
export type Fixture = {
  readonly file: string
  readonly open: (
    observers?: readonly Extension[],
  ) => Effect.Effect<Opened, FixtureFailed, Scope.Scope>
  readonly close: (harness: Harness) => Effect.Effect<void, FixtureFailed>
}

type HostSetup = {
  readonly file: string
  readonly tools: ToolSet
  readonly options: ToolsOptions
  readonly settings: Partial<HarnessSettings>
  readonly fauxOptions: ProviderOptions & { readonly commitFrames?: boolean }
}

/** A frame gate waits for the actual SQLite publication, never a token-rate delay. */
const committedFrame = Effect.fn('Test.committedFrame')(function* (
  harness: Harness,
  id: Conversation['id'],
  expected: string,
) {
  const states = yield* watchLive(harness, id, context)
  yield* Stream.runHead(
    states.pipe(
      Stream.filter(
        (live) =>
          live.generation !== undefined && JSON.stringify(live.generation.message) === expected,
      ),
    ),
  )
})

/** The provider starts only after root creation. Its optional gate commits bounded meaningful
 * prefixes; keep the provider's non-failing gate contract while propagating I/O defects at its adapter. */
function capturedProvider(fauxOptions: HostSetup['fauxOptions']) {
  const { commitFrames = false, onFrame = () => Effect.void, ...providerOptions } = fauxOptions
  let owner: Option.Option<{ harness: Harness; id: Conversation['id'] }> = Option.none()
  let frames = 0
  function committed(event: AssistantMessageEvent, abortSignal: Option.Option<AbortSignal>) {
    if (!commitFrames || event.type === 'done' || event.type === 'error') return Effect.void
    frames++
    if (event.partial.content.length === 0 || (frames % 16 !== 0 && event.type !== 'text_delta'))
      return Effect.void
    if (Option.isNone(owner))
      return Effect.die(
        new FixtureFailed({ cause: new Error('Provider invoked before its host opened') }),
      )
    const { harness, id } = owner.value
    const expected = JSON.stringify(event.partial)
    return Effect.promise(() =>
      runForPi(
        waitForFrame(Effect.scoped(committedFrame(harness, id, expected)), abortSignal),
        undefined,
      ),
    )
  }
  const faux = streamingProvider({
    ...providerOptions,
    onFrame: (event, abortSignal) =>
      committed(event, abortSignal).pipe(Effect.andThen(onFrame(event, abortSignal))),
  })
  return {
    faux,
    own: (harness: Harness, id: Conversation['id']) => {
      owner = Option.some({ harness, id })
    },
  }
}

/** Reopening creates fresh volatile registries/models on the same file. Register each release
 * before the next write; the storage release follows the harness release in the child's LIFO scope. */
const openFixture = Effect.fn('Test.openFixture')(function* (
  setup: HostSetup,
  observers: readonly Extension[],
) {
  const captured = capturedProvider(setup.fauxOptions)
  const faux = captured.faux
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  for (const extension of observers) registry.install(extension)
  registry.install(
    yield* Effect.tryPromise({
      try: () => toolsExtension('conformance', setup.tools, setup.options),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
  )
  const storage = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => openNodeSqliteStorage(setup.file),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (value) => Effect.promise(() => value.close(context)),
  )
  const harness = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        Harness.open(
          storage,
          { models, registry, settings: { retry: { baseDelayMs: 0 }, ...setup.settings } },
          context,
        ),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (value) => Effect.promise(() => value.close(context)),
  )
  const root = yield* Effect.tryPromise({
    try: () => harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } }),
    catch: (cause) => new FixtureFailed({ cause }),
  })
  captured.own(harness, root.id)
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://durable.test/chat',
    fetch: (url, init) => respond(harness, root.id, new Request(url, init), context),
  })
  return { harness, root, faux, transport }
})

/** Own the temporary file before any write. Each open owns a child scope; closing it is idempotent
 * and releases SQLite before a restart assertion reopens the same durable transcript. */
export const host = Effect.fn('Test.host')(function* (
  tools: ToolSet,
  options: ToolsOptions,
  settings: Partial<HarnessSettings> = {},
  fauxOptions: ProviderOptions & { readonly commitFrames?: boolean } = {},
): Effect.fn.Return<Fixture, FixtureFailed, Scope.Scope> {
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), 'vivid-conformance-')),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  )
  const file = NodePath.join(directory, 'session.sqlite')
  const setup: HostSetup = { file, tools, options, settings, fauxOptions }
  const opened = new Map<Harness, Scope.Closeable>()
  const parent = yield* Effect.scope
  const open = (
    observers: readonly Extension[] = [],
  ): Effect.Effect<Opened, FixtureFailed, Scope.Scope> =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(parent)
      const value = yield* Scope.provide(openFixture(setup, observers), scope)
      opened.set(value.harness, scope)
      return value
    })
  /** Explicit close retires that child's finalizers; the parent can safely close it again at teardown. */
  const close = Effect.fn('Test.closeHost')(function* (harness: Harness) {
    const scope = opened.get(harness)
    if (scope === undefined) return
    yield* Scope.close(scope, Exit.void)
    opened.delete(harness)
  })
  return { open, close, file }
})

/** Approval and person-answered tools shared by the HITL and actual SDK consumer suites. */
export const shop = Effect.fn('Test.shop')(function* (
  settings: Partial<HarnessSettings> = {},
): Effect.fn.Return<Fixture & { paid: number[] }, FixtureFailed, Scope.Scope> {
  const paid: number[] = []
  const fixture = yield* host(
    {
      pay: tool({
        description: 'Pay an invoice',
        inputSchema: z.object({ amount: z.number() }),
        execute: ({ amount }) => {
          paid.push(amount)
          return Promise.resolve({ receipt: amount })
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
})
