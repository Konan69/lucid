import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
  createRegistry,
  Harness,
  type EntryId,
  type Storage,
  type Tx,
  type ConversationId,
} from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import { Effect, Option, type Scope } from 'effect'
import type { UIMessage } from 'ai'
import * as Core from '../core.ts'
import { history } from '../main.ts'
import { FixtureFailed } from './harness.ts'
import { runForPi } from '../pi.ts'

type Opener = () => Effect.Effect<Storage, FixtureFailed, Scope.Scope>

const context = BACKGROUND_CONTEXT
const encoder = new TextEncoder()

/** Count the public Storage reads while forwarding every operation to a real
 * backend. Explicit binding preserves receivers, overloads and generic mintId;
 * nothing on the SDK instance is replaced or mocked. */
function counted(source: Storage) {
  const reads: { readonly limit: number; readonly entries: readonly EntryId[] }[] = []
  const storage: Storage = {
    commit: source.commit.bind(source),
    mintId: source.mintId.bind(source),
    conversation: source.conversation.bind(source),
    scanConversations: source.scanConversations.bind(source),
    entry: source.entry.bind(source),
    findLatestHeadMarker: source.findLatestHeadMarker.bind(source),
    scanEntries: (query, limit, cursor, supplied) =>
      source.scanEntries(query, limit, cursor, supplied).then((page) => {
        reads.push({ limit, entries: page.items.map((entry) => entry.id) })
        return page
      }),
    task: source.task.bind(source),
    scanTasks: source.scanTasks.bind(source),
    submission: source.submission.bind(source),
    scanSubmissions: source.scanSubmissions.bind(source),
    submissionByRequest: source.submissionByRequest.bind(source),
    findDocument: source.findDocument.bind(source),
    document: source.document.bind(source),
    scanDocuments: source.scanDocuments.bind(source),
    close: source.close.bind(source),
  }
  return { storage, reads }
}

/** Fresh real storage owns each case; close the Harness before backend cleanup.
 * Host-written entries avoid model scheduling and make scan bounds deterministic. */
const host = Effect.fn('Test.historyHost')(function* (open: Opener) {
  const counting = counted(yield* open())
  const models = createModels()
  models.setProvider(fauxProvider().provider)
  const harness = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => Harness.open(counting.storage, { models, registry: createRegistry() }, context),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
    (opened) => Effect.promise(() => opened.close(context)),
  )
  const root = yield* Effect.promise(() =>
    harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } }),
  )
  return { harness, root, reads: counting.reads }
})

/** Await every append before the SDK transaction may commit. */
const appendUser = Effect.fn('Test.appendHistoryUser')(function* (
  tx: Tx,
  id: ConversationId,
  text: string,
) {
  yield* Effect.promise(() =>
    tx.appendEntry(id, { kind: 'pi.user', model: [{ role: 'user', content: text, timestamp: 0 }] }),
  )
})
/** Host-written responses exercise complete stretches without model scheduling. */
const appendAssistant = Effect.fn('Test.appendHistoryAssistant')(function* (
  tx: Tx,
  id: ConversationId,
  text: string,
) {
  yield* Effect.promise(() =>
    tx.appendEntry(id, { kind: 'pi.assistant', model: [fauxAssistantMessage(text)] }),
  )
})
/** Multibyte messages and metadata distinguish JSON UTF-8 sizes from text lengths. */
const writeTranscript = Effect.fn('Test.writeHistory')(function* (tx: Tx, id: ConversationId) {
  for (const text of ['Older', 'Middle', 'Newest 🌍']) {
    yield* appendUser(tx, id, text)
    yield* appendAssistant(tx, id, `Answer: ${text}`)
  }
})
/** Older rows reveal accidental 100-row reads. Assistants need the user lookahead. */
const writeMany = Effect.fn('Test.writeMany')(function* (
  tx: Tx,
  id: ConversationId,
  assistant: boolean,
) {
  for (let index = 0; index < 150; index++) yield* appendUser(tx, id, `Older ${index}`)
  yield* appendUser(tx, id, 'Newest')
  if (assistant) for (const text of ['A', 'B', 'C']) yield* appendAssistant(tx, id, text)
})
/** Three settled stretches include multibyte text; JSON byte budgets must count
 * UTF-8 rather than code units and retain response metadata/step parts too. */
const transcript = Effect.fn('Test.historyTranscript')(function* (
  setup: Effect.Success<ReturnType<typeof host>>,
) {
  yield* Effect.promise(() =>
    setup.root.commit((tx) => runForPi(writeTranscript(tx, setup.root.id), undefined), context),
  )
  return yield* Effect.promise(() => history(setup.harness, setup.root.id, { limit: 20 }, context))
})

/** Size the observable wire messages, not private entries or provider buffers. */
function bytes(messages: readonly UIMessage[]) {
  return messages.reduce(
    (sum, message) => sum + encoder.encode(JSON.stringify(message)).byteLength,
    0,
  )
}

/** Count returned rows: one user, or a full assistant and its user boundary. */
const singleMessage = Effect.fn('Test.singleMessage')(function* (open: Opener, assistant: boolean) {
  const setup = yield* host(open)
  yield* Effect.promise(() =>
    setup.root.commit(
      (tx) => runForPi(writeMany(tx, setup.root.id, assistant), undefined),
      context,
    ),
  )
  setup.reads.length = 0
  const page = yield* Effect.promise(() =>
    history(setup.harness, setup.root.id, { limit: 1 }, context),
  )
  expect(page.messages).toHaveLength(1)
  expect(Option.getOrThrow(Option.fromNullishOr(page.messages[0])).role).toBe(
    assistant ? 'assistant' : 'user',
  )
  expect(setup.reads.every((read) => read.limit === 1)).toBe(true)
  expect(setup.reads.flatMap((read) => read.entries)).toHaveLength(assistant ? 4 : 1)
  expect(page.next).toBeDefined()
})

/** Exact inclusion uses UTF-8 JSON bytes. All cursor pages recover the unbounded read. */
const boundaryBudget = Effect.fn('Test.boundaryBudget')(function* (open: Opener) {
  const setup = yield* host(open)
  const unbounded = yield* transcript(setup)
  const newest = unbounded.messages.slice(-2)
  const maxBytes = bytes(newest)
  const page = yield* Effect.promise(() =>
    history(setup.harness, setup.root.id, { limit: 20, maxBytes }, context),
  )
  expect(page.messages).toEqual(newest)
  expect(page.oversized).toBeUndefined()
  const core = yield* Core.history(
    setup.harness,
    setup.root.id,
    { limit: 20, before: Option.none(), maxBytes: Option.some(maxBytes) },
    context,
  )
  expect(core.messages).toEqual(page.messages)
  expect(Option.isNone(core.oversized)).toBe(true)
  expect(Option.isSome(core.next)).toBe(true)
  const pages = [page.messages]
  let before = page.next
  const cursors = new Set<string>()
  while (before !== undefined) {
    expect(cursors.has(before)).toBe(false)
    cursors.add(before)
    const next = yield* Effect.promise(() =>
      history(setup.harness, setup.root.id, { limit: 20, before, maxBytes }, context),
    )
    expect(next.messages.length).toBeGreaterThan(0)
    expect(bytes(next.messages)).toBeLessThanOrEqual(maxBytes)
    pages.push(next.messages)
    before = next.next
  }
  expect(pages.toReversed().flat()).toEqual(unbounded.messages)
})

/** An oversized newest message returns once and preserves all older messages. */
const oversizedMessage = Effect.fn('Test.oversizedMessage')(function* (open: Opener) {
  const setup = yield* host(open)
  const unbounded = yield* transcript(setup)
  const newest = unbounded.messages.slice(-1)
  const maxBytes = bytes(newest) - 1
  const page = yield* Effect.promise(() =>
    history(setup.harness, setup.root.id, { limit: 20, maxBytes }, context),
  )
  expect(page.messages).toEqual(newest)
  expect(page.oversized).toEqual(
    Core.HistoryOversized.make({
      messageId: Option.getOrThrow(Option.fromNullishOr(newest[0])).id,
      bytes: bytes(newest),
      maxBytes,
    }),
  )
  const core = yield* Core.history(
    setup.harness,
    setup.root.id,
    { limit: 20, before: Option.none(), maxBytes: Option.some(maxBytes) },
    context,
  )
  expect(Option.getOrThrow(core.oversized)).toEqual(page.oversized)
  if (page.next === undefined) throw new Error('Expected older message continuation')
  const rest = yield* Effect.promise(() =>
    history(setup.harness, setup.root.id, { limit: 20, before: page.next }, context),
  )
  expect([...rest.messages, ...page.messages]).toEqual(unbounded.messages)
  expect(rest.next).toBeUndefined()
})

/** An oversized message at EOF terminates without an empty retry page. */
const finalOversized = Effect.fn('Test.finalOversized')(function* (open: Opener) {
  const setup = yield* host(open)
  yield* Effect.promise(() =>
    setup.root.commit(
      (tx) =>
        tx.appendEntry(setup.root.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: 'Only 🌍', timestamp: 0 }],
        }),
      context,
    ),
  )
  const page = yield* Effect.promise(() =>
    history(setup.harness, setup.root.id, { limit: 1, maxBytes: 1 }, context),
  )
  expect(page.messages).toHaveLength(1)
  expect(page.oversized).toEqual(
    Core.HistoryOversized.make({
      messageId: Option.getOrThrow(Option.fromNullishOr(page.messages[0])).id,
      bytes: bytes(page.messages),
      maxBytes: 1,
    }),
  )
  expect(page.next).toBeUndefined()
})

/** Both public APIs reject invalid budgets with the tagged request failure. */
const invalidBudget = Effect.fn('Test.invalidBudget')(function* (open: Opener, maxBytes: number) {
  const setup = yield* host(open)
  const core = yield* Effect.flip(
    Core.history(
      setup.harness,
      setup.root.id,
      { limit: 1, before: Option.none(), maxBytes: Option.some(maxBytes) },
      context,
    ),
  )
  expect(core).toBeInstanceOf(Core.HistoryPageInvalid)
  const promise = yield* Effect.flip(
    Effect.tryPromise({
      try: () => history(setup.harness, setup.root.id, { limit: 1, maxBytes }, context),
      catch: (cause) => new FixtureFailed({ cause }),
    }),
  )
  expect(promise.cause).toBeInstanceOf(Core.HistoryPageInvalid)
})

/** Both real backends run identical public paging proofs with cleanup before writes. */
export function historyCases(backend: string, open: Opener) {
  describe(`${backend} bounded history`, () => {
    it.live.each([false, true])(
      'limit 1 reads only one message and its boundary (assistant=%s)',
      (assistant) => singleMessage(open, assistant),
    )
    it.live('stops at the exact byte boundary and continues without loss', () =>
      boundaryBudget(open),
    )
    it.live('returns an oversized message alone with a typed marker and advancing cursor', () =>
      oversizedMessage(open),
    )
    it.live('returns a lone oversized final message without a continuation', () =>
      finalOversized(open),
    )
    it.live.each([0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects invalid byte budget %s through both APIs',
      (maxBytes) => invalidBudget(open, maxBytes),
    )
  })
}
