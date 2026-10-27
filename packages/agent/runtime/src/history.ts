import { copyJson } from '@earendil-works/chord'
import * as NodeCrypto from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  defineDocFamily,
  type ConversationId,
  type EntryDraft,
  type EntryId,
  type SubmissionId,
  type Tx,
} from '@earendil-works/pi-durable'
import {
  MemoryAuthority,
  MemoryRevision,
  MemorySource,
  NoteAddress,
  NoteWrite,
  RuntimeHistoryAnswer,
  RuntimeHistoryInput,
  RuntimeHistoryResult,
  RuntimeSubmissionId,
  type RuntimeHistoryBody,
  type RuntimeHistoryThread,
  RuntimeHistoryEntry,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { Notes } from './notes.ts'
import type { PersonConversations } from './person.ts'
import { Answered, RESPONSE_ENTRY, RUN_ENTRY } from './response.ts'
import {
  ConversationThread,
  conversationOf,
  pi,
  PiRejected,
  THREAD_KEY,
  ThreadConversation,
} from './threads.ts'

/** Marker and receipts are committed with the transcript, so retries cannot append duplicates. */
const Loaded = defineDocFamily<
  { fingerprint: string; deliveries: Array<{ requestId: string; submissionId: number }> },
  { fingerprint: string; deliveries: Array<{ requestId: string; submissionId: number }> }
>({
  kind: 'vivid.history',
  version: 1,
  scope: 'conversation',
  family: true,
  checkpointWhen: () => false,
  history: 'latest',
  fork: 'initial',
  initial: (value) => value,
})
class InvalidHistory extends Schema.TaggedError<InvalidHistory>()(
  'InvalidHistory',
  {},
  { title: 'History references do not match its entries' },
) {}
interface Placed {
  readonly submission: SubmissionId
  readonly entry: EntryId
}
interface Writing {
  readonly tx: Tx
  readonly conversationId: ConversationId
  readonly placed: Map<string, Placed>
  readonly unsettled: Set<string>
  answer: Option.Option<EntryId>
  detail: Option.Option<string>
}

/** References must already have been placed. Throwing inside Pi's public commit rolls it back. */
const placedOf = (writing: Writing, requests: ReadonlyArray<string>) =>
  requests.map((request) => {
    const placed = writing.placed.get(request)
    if (placed === undefined) throw new InvalidHistory()
    return placed
  })
const named = (placed: ReadonlyArray<Placed>) =>
  placed.map(({ submission, entry }) => ({ submission, entry }))

/** Display writes retain the request ids used by the runtime's settlement hooks. */
const displayed = (writing: Writing, requestId: string, draft: EntryDraft) =>
  writing.tx
    .appendEntry(writing.conversationId, draft)
    .then((entry) =>
      writing.tx.createSubmission({
        conversationId: writing.conversationId,
        requestId,
        type: 'write',
        status: 'done',
        entry: entry.id,
      }),
    )
    .then(() => {})

/** A response settles every delivery in the creating commit and records the host of joined replies. */
const responded = (writing: Writing, item: typeof RuntimeHistoryEntry.cases.Response.Type) => {
  const placed = placedOf(
    writing,
    item.inputs.map((input) => input.requestId),
  )
  const [host] = placed
  if (host === undefined)
    return writing.tx.appendEntry(writing.conversationId, draftOf(item.draft)).then(() => {})
  const answer = writing.answer
  item.inputs.forEach((input, index) => {
    writing.unsettled.delete(input.requestId)
    const at = placed[index]
    if (at === undefined) throw new InvalidHistory()
    RuntimeHistoryInput.match(input, {
      completed: () => {
        if (Option.isNone(answer)) throw new InvalidHistory()
        writing.tx.settleSubmission(at.submission, { status: 'done', answer: answer.value })
      },
      aborted: () =>
        writing.tx.settleSubmission(at.submission, { status: 'unanswered', reason: 'aborted' }),
      failed: ({ failure }) =>
        writing.tx.settleSubmission(at.submission, {
          status: 'unanswered',
          reason: failure === null ? 'history_failed' : failure,
          detail: Option.getOrNull(writing.detail),
        }),
    })
  })
  writing.answer = Option.none()
  writing.detail = Option.none()
  return Promise.all(
    placed.slice(1).map((joined) =>
      writing.tx
        .doc(Answered, writing.conversationId, String(joined.submission), host.submission)
        .then((doc) => {
          doc.by = host.submission
        }),
    ),
  ).then(() =>
    displayed(writing, `${RESPONSE_ENTRY}:${host.submission}`, {
      ...item.draft,
      data: copyJson({ ...item.draft.data, inputs: named(placed) }),
    }),
  )
}

/** Chord copies JSON into its mutable storage representation without changing the wire value. */
const draftOf = (draft: typeof RuntimeHistoryEntry.cases.Entry.Type.draft): EntryDraft => ({
  ...draft,
  data: draft.data === undefined ? undefined : copyJson(draft.data),
})

/** Each entry precedes any reference to it; no imported submission is left queued. */
const append = (writing: Writing, item: RuntimeHistoryEntry): Promise<void> =>
  RuntimeHistoryEntry.match(item, {
    Entry: ({ draft }) =>
      writing.tx.appendEntry(writing.conversationId, draftOf(draft)).then((entry) => {
        if (draft.kind === 'pi.assistant') {
          writing.answer = Option.some(entry.id)
          const assistant =
            draft.model === undefined
              ? undefined
              : draft.model.find((message) => message.role === 'assistant')
          writing.detail = Option.fromUndefinedOr(
            assistant === undefined ? undefined : assistant.errorMessage,
          )
        }
      }),
    Delivery: ({ draft, requestId }) => {
      if (writing.placed.has(requestId)) throw new InvalidHistory()
      return writing.tx.appendEntry(writing.conversationId, draftOf(draft)).then((entry) =>
        writing.tx
          .createSubmission({
            conversationId: writing.conversationId,
            requestId,
            type: 'input',
            status: 'queued',
          })
          .then((submission) => {
            writing.tx.placeSubmission(submission.id, entry.id)
            writing.unsettled.add(requestId)
            writing.placed.set(requestId, { submission: submission.id, entry: entry.id })
          }),
      )
    },
    Run: ({ inputs }) => {
      const placed = placedOf(writing, inputs)
      const [host] = placed
      return host === undefined
        ? Promise.resolve()
        : displayed(writing, `${RUN_ENTRY}:${host.submission}:${placed.length}`, {
            kind: RUN_ENTRY,
            data: { inputs: named(placed) },
          })
    },
    Response: (response) => responded(writing, response),
  })

/** Creation, Thread lookup, attribution, transcript and marker are one native atomic commit. */
const write = (
  tx: Tx,
  conversationId: ConversationId,
  thread: RuntimeHistoryThread,
  fingerprint: string,
) =>
  tx
    .doc(ThreadConversation, thread.threadId, conversationId)
    .then((mapping) => {
      if (mapping.conversationId !== conversationId) throw new InvalidHistory()
      return tx.doc(ConversationThread, conversationId, THREAD_KEY, {
        threadId: thread.threadId,
        ...thread.origin,
      })
    })
    .then(() => {
      const writing: Writing = {
        tx,
        conversationId,
        placed: new Map(),
        unsettled: new Set(),
        answer: Option.none(),
        detail: Option.none(),
      }
      return thread.entries
        .reduce<Promise<void>>(
          (before, entry) => before.then(() => append(writing, entry)),
          Promise.resolve(),
        )
        .then(() => {
          if (writing.unsettled.size > 0) throw new InvalidHistory()
          const deliveries = [...writing.placed].map(([requestId, placed]) => ({
            requestId,
            submissionId: placed.submission,
          }))
          return tx
            .doc(Loaded, conversationId, THREAD_KEY, { fingerprint, deliveries })
            .then(() => {})
        })
    })

/** Only an identical history load may reuse a conversation. Live conversations are never replaced. */
const loadThread = Effect.fn('History.thread')(function* (
  person: PersonConversations,
  thread: RuntimeHistoryThread,
) {
  const fingerprint = NodeCrypto.createHash('sha256').update(JSON.stringify(thread)).digest('hex')
  const existing = yield* conversationOf(person.harness, thread.threadId)
  let conversationId: ConversationId
  if (Option.isSome(existing)) conversationId = existing.value.id
  else {
    const conversation = yield* pi(() =>
      person.harness.createConversation(
        { ownership: { kind: 'ownerless' }, init: (tx, id) => write(tx, id, thread, fingerprint) },
        BACKGROUND_CONTEXT,
      ),
    )
    conversationId = conversation.id
  }
  const marker = yield* pi(() =>
    person.harness.snapshot(Loaded, conversationId, THREAD_KEY, BACKGROUND_CONTEXT),
  )
  if (marker === undefined)
    return RuntimeHistoryResult.cases.Refused.make({
      threadId: thread.threadId,
      reason: 'ExistingConversation',
    })
  if (marker.fingerprint !== fingerprint)
    return RuntimeHistoryResult.cases.Refused.make({
      threadId: thread.threadId,
      reason: 'ChangedHistory',
    })
  return RuntimeHistoryResult.cases.Loaded.make({
    threadId: thread.threadId,
    deliveries: marker.deliveries.map((row) => ({
      requestId: row.requestId,
      submissionId: RuntimeSubmissionId.make(row.submissionId),
    })),
  })
})

/** Notes use compare-and-write revision zero. Identical imports leave their revision unchanged. */
const loadNotes = Effect.fn('History.notes')(function* (
  person: PersonConversations,
  body: RuntimeHistoryBody,
) {
  const notes = yield* Notes
  for (const note of body.notes) {
    const address = NoteAddress.make(note)
    const existing = yield* notes.read(person.personId, address).pipe(
      Effect.asSome,
      Effect.catchTag('NoteMissing', (missing) =>
        missing.revision === 0 ? Effect.succeedNone : Effect.fail(new InvalidHistory()),
      ),
    )
    if (Option.isSome(existing)) {
      const saved = existing.value
      if (
        saved.layer !== note.layer ||
        saved.file !== note.file ||
        saved.kind !== note.kind ||
        saved.description !== note.description ||
        saved.body !== note.body ||
        saved.basis !== note.basis ||
        saved.updatedAt !== note.updatedAt ||
        !MemorySource.guards.HistoryLoad(saved.authority.source)
      )
        return yield* new InvalidHistory()
      continue
    }
    yield* notes.write(
      person.personId,
      NoteWrite.make({
        note,
        expected: MemoryRevision.make(0),
        authority: MemoryAuthority.make({
          actor: person.personId,
          source: MemorySource.cases.HistoryLoad.make({ updatedAt: note.updatedAt }),
        }),
      }),
    )
  }
})

/** Partial Thread success is explicit. An error cannot be mistaken for an empty successful load. */
export const loadHistory = Effect.fn('History.load')(function* (
  person: PersonConversations,
  body: RuntimeHistoryBody,
) {
  yield* loadNotes(person, body).pipe(Effect.mapError((cause) => new PiRejected({ cause })))
  const threads = yield* Effect.forEach(body.threads, (thread) =>
    loadThread(person, thread).pipe(
      Effect.catchTag('PiRejected', (failure) =>
        Effect.succeed(
          RuntimeHistoryResult.cases.Refused.make({
            threadId: thread.threadId,
            reason: failure.cause instanceof InvalidHistory ? 'InvalidHistory' : 'Unavailable',
          }),
        ),
      ),
    ),
  )
  return RuntimeHistoryAnswer.make({ threads })
})
