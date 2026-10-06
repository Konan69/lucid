import type { Context } from '@earendil-works/chord'
import type { UserMessage, TextContent, ImageContent } from '@earendil-works/pi-ai'
import {
  LiveDoc,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Cursor,
} from '@earendil-works/pi-durable'
import type { UIMessage, UIMessageChunk } from 'ai'
import { Data, Effect, Match, Option, Predicate, Schema, Stream } from 'effect'
import { emptyRound, present, type Desk } from './calls.ts'
import { rebuild, type Rebuilt } from './chunks.ts'
import { noDesk, readDesk, type Reader } from './desk.ts'
import * as Pi from './pi.ts'
import { readMessage } from './reading.ts'
import { HistoryCursorInvalid, HistoryPageInvalid } from './errors.ts'
import { decodeStoredImage } from './input.ts'

/** Pi's numeric identity is checked only at the opaque cursor's wire ingress. */
const EntryIdentity = Schema.declare<EntryId>(
  (value): value is EntryId =>
    Predicate.isNumber(value) && Number.isSafeInteger(value) && value > 0,
)
/** Exclusive entry bound owned by this library, independent of Pi's storage cursor. */
export const HistoryCursor = Schema.Struct({ entry: EntryIdentity }).pipe(
  Schema.brand('Durable.HistoryCursor'),
)
export type HistoryCursor = typeof HistoryCursor.Type
export type HistoryPage = {
  readonly messages: readonly UIMessage[]
  readonly next: Option.Option<HistoryCursor>
}
export type HistoryRequest = {
  readonly limit: number
  readonly before: Option.Option<HistoryCursor>
}
const Limit = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))

type Group = Data.TaggedEnum<{
  User: { readonly entry: EntryRecord }
  Assistant: { readonly entries: readonly EntryRecord[] }
}>
const Group = Data.taggedEnum<Group>()
type Prepared = Data.TaggedEnum<{
  User: { readonly entry: EntryRecord }
  Assistant: { readonly identity: EntryId; readonly step: Rebuilt }
}>
const Prepared = Data.taggedEnum<Prepared>()

/** Ignore control/application entries; close each assistant stretch only at a user boundary or EOF. */
function groups(entries: readonly EntryRecord[], exhausted: boolean) {
  const completed: Group[] = []
  let assistant: EntryRecord[] = []
  for (const entry of entries) {
    Match.value(entry.kind).pipe(
      Match.when('pi.user', () => {
        if (assistant.some((item) => item.kind === 'pi.assistant'))
          completed.push(Group.Assistant({ entries: assistant.toReversed() }))
        assistant = []
        completed.push(Group.User({ entry }))
      }),
      Match.when(Match.is('pi.assistant', 'pi.tool-result'), () => {
        assistant.push(entry)
      }),
      // Entry kinds are an open SDK extension vocabulary, including application-owned kinds.
      Match.orElse(() => {}),
    )
  }
  if (exhausted && assistant.some((item) => item.kind === 'pi.assistant'))
    completed.push(Group.Assistant({ entries: assistant.toReversed() }))
  return completed
}

/** Known input placements locate the active prefix without scanning submissions or needing Storage. */
const boundary = Effect.fn('Durable.historyBoundary')(function* (reader: Reader) {
  const live = yield* Pi.snapshot(reader.harness, LiveDoc, reader.conversation.id, reader.context)
  if (Option.isNone(live) || live.value.run === undefined) return Option.none<EntryId>()
  const placed: EntryId[] = []
  for (const id of live.value.run.inputs) {
    const input = yield* Pi.submission(reader.harness, id, reader.context)
    if (Option.isNone(input)) continue
    const receipt = yield* Pi.status(input.value, reader.context)
    if (receipt.entry !== undefined) placed.push(receipt.entry)
  }
  if (placed.length > 0)
    return Option.some(placed.reduce((first, entry) => (entry < first ? entry : first)))
  // generation.js startRun accepts placed inputs only, and draining steers appends placed ids.
  // A run without their entries violates Pi's invariant; do not fabricate a history boundary.
  throw new Error('Pi active run has no placed input entry')
})

/** Pi's inclusive query bound is filtered to the cursor's exclusive message boundary below. */
function queryFor(before: Option.Option<HistoryCursor>) {
  return Option.isNone(before) ? {} : { maxEntryId: before.value.entry }
}

type CursorCheck = Data.TaggedEnum<{ Initial: {}; Assistant: {}; Valid: {}; Invalid: {} }>
const CursorCheck = Data.taggedEnum<CursorCheck>()

/** Control entries are transparent; a second assistant before a user means the bound split a stretch. */
function checkCursor(state: CursorCheck, entry: EntryRecord, expected: EntryId): CursorCheck {
  return CursorCheck.$match(state, {
    Valid: () => state,
    Invalid: () => state,
    Initial: () =>
      entry.id !== expected
        ? CursorCheck.Invalid()
        : Match.value(entry.kind).pipe(
            Match.when('pi.user', () => CursorCheck.Valid()),
            Match.when('pi.assistant', () => CursorCheck.Assistant()),
            Match.orElse(() => CursorCheck.Invalid()),
          ),
    Assistant: () =>
      Match.value(entry.kind).pipe(
        Match.when('pi.user', () => CursorCheck.Valid()),
        Match.when('pi.assistant', () => CursorCheck.Invalid()),
        Match.orElse(() => state),
      ),
  })
}

/** A bound inside a stretch would truncate it under a stable id. Validate against raw entries first. */
const validateCursor = Effect.fn('Durable.historyCursor')(function* (
  reader: Reader,
  before: HistoryCursor,
) {
  const query = { maxEntryId: before.entry }
  let cursor = Option.none<Cursor>()
  let state: CursorCheck = CursorCheck.Initial()
  for (;;) {
    const batch = yield* Pi.entries(
      reader.conversation,
      { query, limit: 100, cursor },
      reader.context,
    )
    for (const entry of batch.items) state = checkCursor(state, entry, before.entry)
    if (CursorCheck.$is('Valid')(state)) return yield* Effect.void
    if (CursorCheck.$is('Invalid')(state))
      return yield* new HistoryCursorInvalid({ conversationId: reader.conversation.id })
    cursor = Option.fromNullishOr(batch.next)
    if (Option.isNone(cursor))
      return yield* CursorCheck.$is('Assistant')(state)
        ? Effect.void
        : Effect.fail(new HistoryCursorInvalid({ conversationId: reader.conversation.id }))
  }
})

/**
 * Reconnect supplies the active assistant, while history supplies its preceding user inputs.
 * Entries arrive newest first: find the earliest active assistant before admitting any active
 * users. A steer placed after that assistant stays hidden until settlement, because reconnect
 * cannot insert a user message between the assistant's steps.
 */
function historyEntries(entries: readonly EntryRecord[], active: Option.Option<EntryId>) {
  return Option.match(active, {
    onNone: () => entries,
    onSome: (input) => {
      const first = entries.findLast((entry) => entry.id >= input && entry.kind === 'pi.assistant')
      return entries.filter(
        (entry) =>
          entry.id < input ||
          (entry.kind === 'pi.user' && (first === undefined || entry.id < first.id)),
      )
    },
  })
}

/** Read another raw page until enough complete messages exist; never split a multi-entry stretch. */
const readGroups = Effect.fn('Durable.historyGroups')(function* (
  reader: Reader,
  page: HistoryRequest,
) {
  const active = yield* boundary(reader)
  if (Option.isSome(page.before)) yield* validateCursor(reader, page.before.value)
  const query = queryFor(page.before)
  let cursor = Option.none<Cursor>()
  const entries: EntryRecord[] = []
  for (;;) {
    const batch = yield* Pi.entries(
      reader.conversation,
      { query, limit: 100, cursor },
      reader.context,
    )
    entries.push(
      ...batch.items.filter(
        (entry) => query.maxEntryId === undefined || entry.id < query.maxEntryId,
      ),
    )
    cursor = Option.fromNullishOr(batch.next)
    // Read the whole active prefix before counting messages, even if late steers fill a raw page.
    // If the caller's cursor already hides the first assistant, all remaining active users precede it.
    if (
      Option.isSome(active) &&
      Option.isSome(cursor) &&
      entries.every((entry) => entry.id > active.value)
    )
      continue
    const completed = groups(historyEntries(entries, active), Option.isNone(cursor))
    if (completed.length > page.limit || Option.isNone(cursor)) return completed
  }
})

/** Restore bridge filenames from Pi's stored image JSON, leaving native images without filenames. */
function userPart(part: TextContent | ImageContent): UIMessage['parts'][number] {
  if (part.type === 'text') return { type: 'text', text: part.text }
  const stored = decodeStoredImage(part)
  const file = {
    type: 'file' as const,
    mediaType: stored.mimeType,
    url: `data:${stored.mimeType};base64,${stored.data}`,
  }
  return stored.filename === undefined ? file : { ...file, filename: stored.filename }
}

/** Images have the SDK's supported data-URL file shape; late-answer users are ordinary user messages. */
function userMessage(entry: EntryRecord): UIMessage {
  const model = (entry.model ?? []).find(
    (message): message is UserMessage => message.role === 'user',
  )
  if (model === undefined) throw new Error('Pi user entry has no user message')
  const parts: UIMessage['parts'] = Predicate.isString(model.content)
    ? [{ type: 'text', text: model.content }]
    : model.content.map(userPart)
  return { id: `entry:${entry.id}`, role: 'user', parts }
}

/** Replaced errors vanish; aborted inputs retain their SDK input error, never an executable input. */
function settledEntries(entries: readonly EntryRecord[]) {
  return entries.flatMap((entry, index) => {
    const model = (entry.model ?? [])[0]
    if (model === undefined || model.role !== 'assistant') return [entry]
    const following = entries.slice(index + 1)
    if (model.stopReason === 'error' && following.some((item) => item.kind === 'pi.assistant'))
      return []
    const nextAssistant = following.findIndex((item) => item.kind === 'pi.assistant')
    const results = new Set(
      (nextAssistant === -1 ? following : following.slice(0, nextAssistant)).flatMap((item) =>
        (item.model ?? []).flatMap((message) =>
          message.role === 'toolResult' ? [message.toolCallId] : [],
        ),
      ),
    )
    return [
      {
        ...entry,
        model: [
          {
            ...model,
            content: model.content.filter(
              (part) =>
                part.type !== 'toolCall' || results.has(part.id) || model.stopReason === 'aborted',
            ),
          },
        ],
      },
    ]
  })
}

/** The same translator and presentation create chunks; the SDK reader alone assembles their UI parts. */
const assistantMessage = Effect.fn('Durable.historyAssistant')(function* (
  prepared: Extract<Prepared, { _tag: 'Assistant' }>,
  desk: Desk,
) {
  const { step, identity } = prepared
  const shown = present(emptyRound, step.chunks, desk)
  const chunks: readonly UIMessageChunk[] = [
    { type: 'start', messageId: `entry:${identity}` },
    ...shown.chunks,
    { type: 'finish-step' },
    { type: 'finish' },
  ]
  return yield* readMessage(yield* Stream.toReadableStreamEffect(Stream.fromIterable(chunks)))
})

/** Rebuild once per selected message; its chunk identities retain provenance in the shared page desk. */
function prepare(group: Group): Prepared {
  return Group.$match(group, {
    User: ({ entry }) => Prepared.User({ entry }),
    Assistant: ({ entries }) => {
      const first = entries.find((entry) => entry.kind === 'pi.assistant')
      if (first === undefined) throw new Error('History assistant group lacks its first entry')
      return Prepared.Assistant({ identity: first.id, step: rebuild(settledEntries(entries)) })
    },
  })
}

/** One page observes plans, holds and any unresolved transcript provenance once for all assistant groups. */
const pageDesk = Effect.fn('Durable.historyDesk')(function* (
  reader: Reader,
  selected: readonly Prepared[],
) {
  const steps = selected.flatMap((group) => (Prepared.$is('Assistant')(group) ? [group.step] : []))
  if (steps.length === 0) return noDesk
  return yield* readDesk(
    reader,
    {
      chunks: steps.flatMap((step) => step.chunks),
      origins: new Map(steps.flatMap((step) => Array.from(step.origins))),
      live: Option.some({ tools: [] }),
    },
    emptyRound.holds,
  )
})

/**
 * Raw fork-aware messages, oldest first. Paging counts messages and never splits an assistant
 * stretch. Control/system/reset/compaction/application entries are skipped. During a run, users
 * before its first assistant entry are included; its assistant and tool results come from attachRun.
 * A steer placed after that assistant stays out until settlement: reconnect cannot show it in order.
 * Known submission placements locate the run without a submissions scan or Storage requirement.
 * Late-answer user entries are ordinary users for now, without answerTo metadata.
 * Settled assistant content follows provider block order. Any multi-call response of a
 * sequential-capable agent can append a withheld call after trailing text, even when its actual
 * round is parallel. Live streams and early attachments follow admission. Pi's startToolRound stores
 * provider order and finishToolRound removes live.tools; reader presentation order is not retained.
 */
export const history: (
  harness: Harness,
  conversationId: ConversationId,
  page: HistoryRequest,
  context: Context,
) => Effect.Effect<
  HistoryPage,
  | import('./errors.ts').ConversationMissing
  | HistoryCursorInvalid
  | HistoryPageInvalid
  | import('./errors.ts').PiFailed
> = Effect.fn('Durable.history')(function* (
  harness: Harness,
  conversationId: ConversationId,
  page: HistoryRequest,
  context: Context,
): Effect.fn.Return<
  HistoryPage,
  | import('./errors.ts').ConversationMissing
  | import('./errors.ts').PiFailed
  | HistoryCursorInvalid
  | HistoryPageInvalid
> {
  yield* Limit.makeEffect(page.limit).pipe(
    Effect.mapError(() => new HistoryPageInvalid({ conversationId })),
  )
  const conversation = yield* Pi.conversation(harness, conversationId, context)
  const reader = { harness, conversation, context }
  const all = yield* readGroups(reader, page)
  const selected = all.slice(0, page.limit).toReversed().map(prepare)
  const desk = yield* pageDesk(reader, selected)
  const messages: UIMessage[] = []
  for (const group of selected)
    messages.push(
      yield* Prepared.$match(group, {
        User: ({ entry }) => Effect.succeed(userMessage(entry)),
        Assistant: (prepared) => assistantMessage(prepared, desk),
      }),
    )
  const oldest = selected[0]
  const next =
    all.length <= page.limit || oldest === undefined
      ? Option.none<HistoryCursor>()
      : Option.some(
          HistoryCursor.make({
            entry: Prepared.$match(oldest, {
              User: ({ entry }) => entry.id,
              Assistant: ({ identity }) => identity,
            }),
          }),
        )
  return { messages, next }
})
