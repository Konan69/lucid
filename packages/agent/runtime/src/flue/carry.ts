import * as NodeCrypto from 'node:crypto'
import { copyJson } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  AssistantEntry,
  ToolResultEntry,
  UserEntry,
  defineDocFamily,
  type ConversationId,
  type EntryDraft,
  type EntryId,
  type Harness,
  type SubmissionId,
  type Tx,
} from '@earendil-works/pi-durable'
import { Data, Effect, Option, Schema } from 'effect'
import { SIGNAL_ENTRY } from '../delivery.ts'
import { Answered, RESPONSE_ENTRY, RUN_ENTRY, type ResponseData } from '../response.ts'
import {
  ConversationThread,
  conversationOf,
  pi,
  PiRejected,
  THREAD_KEY,
  ThreadConversation,
} from '../threads.ts'
import { Item, type Carried, type Input, type Measured } from './fold.ts'

/** What carrying one Thread did. Only an identical imported history may be left in place. */
export type Landed = Data.TaggedEnum<{
  Carried: { readonly entries: number }
  AlreadyThere: {}
}>
export const Landed = Data.taggedEnum<Landed>()

/** An import owns only this conversation. Its source digest keeps unchanged Pi receipts stable. */
const Imported = defineDocFamily<{ fingerprint: string }, string>({
  kind: 'vivid.flue',
  version: 1,
  scope: 'conversation',
  family: true,
  history: 'latest',
  fork: 'initial',
  initial: (fingerprint) => ({ fingerprint }),
})

/** The folded snapshot includes messages, pictures, outcomes, attribution and original times. */
const fingerprintOf = (carried: Carried) =>
  NodeCrypto.createHash('sha256').update(JSON.stringify(carried)).digest('hex')

/** Serving before cutover must never turn an empty native conversation into a successful import. */
export class CreatedByRuntime extends Schema.TaggedError<CreatedByRuntime>()(
  'CreatedByRuntime',
  {},
  { title: 'created by the runtime before import' },
) {}

/**
 * Another commit recorded a conversation for the Thread first (a runtime request, or a second
 * import). The creating commit throws it so Pi rolls the whole commit back.
 */
class RecordedElsewhere extends Schema.TaggedError<RecordedElsewhere>()(
  'RecordedElsewhere',
  {},
  { title: 'Thread conversation recorded by another commit' },
) {}

/**
 * The folded history does not hold together: a run names a delivery that was not placed before
 * it, or a response settled `completed` with no model message to answer it. The fold rules both
 * out; the carry refuses rather than write a submission that names nothing. The creating commit
 * throws it, so nothing of the Thread is written.
 */
export class HistoryInconsistent extends Schema.TaggedError<HistoryInconsistent>()(
  'HistoryInconsistent',
  { submission: Schema.String, reason: Schema.Literals(['unplaced', 'unanswered']) },
  { title: 'Folded Flue history does not hold together' },
) {
  override get message() {
    return `Submission ${this.submission} is ${this.reason} in the folded history`
  }
}

/**
 * Pi's reason for an input Flue settled `failed`. Pi's own reasons name what it saw
 * (`model_error`, `no_model`, `faulted`); Flue's failure is not one of those, and its text is not
 * carried, so `classify` (`failure.ts`) reads it as `Unexplained`. The screens read only the
 * outcome, which `outcomeOf` derives as `failed` from any reason but `aborted`.
 */
const FLUE_FAILED = 'flue_failed'

/** A delivery written as a Pi submission: its id, and the entry it was placed as. */
interface Placed {
  readonly submission: SubmissionId
  readonly entry: EntryId
}

/** What the creating commit has written so far that later items refer to. */
interface Writing {
  readonly tx: Tx
  readonly conversationId: ConversationId
  /** Flue submission id to the Pi submission made for it. */
  readonly placed: Map<string, Placed>
  /** The newest model message of the response being written: what answers its inputs. */
  answer: Option.Option<EntryId>
}

/**
 * A delivery's submission, as Pi's admission leaves one that a run took (`admitSubmission`
 * creates it, an inbox boundary places it at its entry, `placeSubmission`). The request id is
 * Flue's submission id: unique in the conversation, and apart from the runtime's own request ids
 * (`delivery:<key>`, `vivid.response:<n>`, `vivid.run:<n>:<k>`). It is settled with the response
 * that answered it, in the same commit, so it never waits on anything.
 */
function place(writing: Writing, submission: Option.Option<string>, entry: EntryId) {
  if (Option.isNone(submission)) return Promise.resolve()
  const { tx, conversationId } = writing
  return tx
    .createSubmission({
      conversationId,
      requestId: submission.value,
      type: 'input',
      status: 'queued',
    })
    .then((record) => {
      tx.placeSubmission(record.id, entry)
      writing.placed.set(submission.value, { submission: record.id, entry })
    })
}

/**
 * A display-only entry, written as Pi admits one (`admitSubmission`: appended, and a `write`
 * submission settled `done` at it), under the request id the runtime gives the same entry. A
 * later `submit` with that id (`recordResponse` after this commit settles the inputs) finds it
 * and writes nothing.
 */
function writeDisplayed(writing: Writing, requestId: string, draft: EntryDraft) {
  const { tx, conversationId } = writing
  return tx
    .appendEntry(conversationId, draft)
    .then((entry) =>
      tx.createSubmission({
        conversationId,
        requestId,
        type: 'write',
        status: 'done',
        entry: entry.id,
      }),
    )
    .then(() => {})
}

/** The placed submissions of a run's deliveries, host first. */
function placedOf(writing: Writing, inputs: ReadonlyArray<string>) {
  return inputs.map((submission) => {
    const placed = writing.placed.get(submission)
    if (placed === undefined) throw new HistoryInconsistent({ submission, reason: 'unplaced' })
    return placed
  })
}

const named = (placed: ReadonlyArray<Placed>) =>
  placed.map(({ submission, entry }) => ({ submission, entry }))

/** The run's record of its deliveries (`joinHooks` `describe`): one entry per size the run has had. */
function ran(writing: Writing, inputs: ReadonlyArray<string>) {
  const placed = placedOf(writing, inputs)
  const [first] = placed
  if (first === undefined) return Promise.resolve()
  return writeDisplayed(writing, `${RUN_ENTRY}:${first.submission}:${placed.length}`, {
    kind: RUN_ENTRY,
    data: { inputs: named(placed) },
  })
}

/** How Pi's run would have settled one input: answered by its last model message, or not. */
function settle(writing: Writing, flue: string, placed: Placed, outcome: Input['outcome']) {
  if (outcome === 'aborted')
    return writing.tx.settleSubmission(placed.submission, {
      status: 'unanswered',
      reason: 'aborted',
    })
  if (outcome === 'failed')
    return writing.tx.settleSubmission(placed.submission, {
      status: 'unanswered',
      reason: FLUE_FAILED,
    })
  if (Option.isNone(writing.answer))
    throw new HistoryInconsistent({ submission: flue, reason: 'unanswered' })
  return writing.tx.settleSubmission(placed.submission, {
    status: 'done',
    answer: writing.answer.value,
  })
}

/**
 * A response ends as the runtime ends one: every input settled together with the run's outcome
 * (Pi `endRun`), the joined ones named as answered by the host (`nameAnswerer`), and the metadata
 * entry naming the inputs and the outcome (`recordResponse`). A response no delivery began is
 * written as before inputs were recorded, and the screens give it to the run it follows.
 */
function responded(writing: Writing, data: Measured, inputs: ReadonlyArray<Input>) {
  const { tx, conversationId } = writing
  const placed = placedOf(
    writing,
    inputs.map((input) => input.submission),
  )
  const [first] = placed
  if (first === undefined)
    return tx
      .appendEntry(conversationId, { kind: RESPONSE_ENTRY, data: copyJson(data) })
      .then(() => {})
  inputs.forEach((input, index) => {
    const at = placed[index]
    if (at !== undefined) settle(writing, input.submission, at, input.outcome)
  })
  writing.answer = Option.none()
  const answerers = placed.slice(1).map((joined) =>
    tx
      .doc(Answered, conversationId, String(joined.submission), first.submission)
      .then((answered) => {
        answered.by = first.submission
      }),
  )
  return Promise.all(answerers).then(() =>
    writeDisplayed(writing, `${RESPONSE_ENTRY}:${first.submission}`, {
      kind: RESPONSE_ENTRY,
      data: copyJson({ ...data, inputs: named(placed) } satisfies ResponseData),
    }),
  )
}

/** One item as the entry the runtime writes for the same thing (`delivery.ts`, `response.ts`, Pi's tool results). */
const append = (writing: Writing, item: Item): Promise<void> => {
  const { tx, conversationId } = writing
  return Item.$match(item, {
    Said: ({ message, submission }) =>
      tx
        .appendEntry(UserEntry, conversationId, { model: [message] })
        .then((entry) => place(writing, submission, entry.id)),
    Signalled: ({ data, message, submission }) =>
      tx
        .appendEntry(conversationId, { kind: SIGNAL_ENTRY, model: [message], data: copyJson(data) })
        .then((entry) => place(writing, submission, entry.id)),
    Ran: ({ inputs }) => ran(writing, inputs),
    Replied: ({ message }) =>
      tx.appendEntry(AssistantEntry, conversationId, { model: [message] }).then((entry) => {
        writing.answer = Option.some(entry.id)
      }),
    // Pi's own tool results carry their diagnostics as data; an imported one has none.
    Answered: ({ message }) =>
      tx
        .appendEntry(ToolResultEntry, conversationId, {
          model: [message],
          data: { diagnostics: [] },
        })
        .then(() => {}),
    Responded: ({ data, inputs }) => responded(writing, data, inputs),
  })
}

/**
 * The creating commit: the two documents `ensureConversation` writes (where to find the
 * conversation, and who started the Thread), then every entry in order with the submissions and
 * documents the runtime keeps beside them. All of it is one commit, so a Thread is either wholly
 * imported or absent, and every submission in it is settled when it is first seen.
 */
const write = (
  tx: Tx,
  conversationId: ConversationId,
  carried: Carried,
  previous: Option.Option<ConversationId>,
) =>
  tx
    .doc(ThreadConversation, carried.threadId, conversationId)
    .then((recorded) => {
      if (recorded.conversationId !== Option.getOrElse(previous, () => conversationId))
        throw new RecordedElsewhere()
      recorded.conversationId = conversationId
      return tx.doc(ConversationThread, conversationId, THREAD_KEY, {
        threadId: carried.threadId,
        creator: carried.origin.creator,
        creatorName: carried.origin.creatorName,
      })
    })
    .then(() => {
      const writing: Writing = { tx, conversationId, placed: new Map(), answer: Option.none() }
      // Each entry's id is minted before a later item can name it.
      return carried.items.reduce<Promise<void>>(
        (before, item) => before.then(() => append(writing, item)),
        Promise.resolve(),
      )
    })
    .then(() => tx.doc(Imported, conversationId, THREAD_KEY, fingerprintOf(carried)))
    .then(() => {})

/**
 * Earlier rehearsals had no marker. Their raw Flue request ids prove importer ownership;
 * runtime admissions use `delivery:` instead. An empty unmarked conversation has no such proof.
 */
const importedBeforeMarker = Effect.fn('Flue.importedBeforeMarker')(function* (
  harness: Harness,
  conversationId: ConversationId,
  carried: Carried,
) {
  for (const item of carried.items) {
    if (!('submission' in item) || Option.isNone(item.submission)) continue
    const requestId = item.submission.value
    const submission = yield* pi(() =>
      harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), BACKGROUND_CONTEXT),
    )
    return submission !== undefined
  }
  return false
})

/**
 * Write one Thread's Flue history into its creator's store, the way the runtime creates a
 * Thread's conversation (`ensureConversation` in `threads.ts`: an ownerless conversation whose
 * `init` records it) with the history appended in the same `init`.
 *
 * A changed imported snapshot is replaced whole, with the Thread pointer switched in the same
 * commit. Pi has no deletion API, so superseded conversations remain unreachable from the Thread.
 * An identical snapshot keeps its receipts. A runtime-created conversation is a cutover error.
 */
export const carry: (
  harness: Harness,
  carried: Carried,
) => Effect.Effect<Landed, PiRejected | HistoryInconsistent | CreatedByRuntime> = Effect.fn(
  'Flue.carry',
)(function* (harness: Harness, carried: Carried) {
  const existing = yield* conversationOf(harness, carried.threadId)
  if (Option.isSome(existing)) {
    const imported = yield* pi(() =>
      harness.snapshot(Imported, existing.value.id, THREAD_KEY, BACKGROUND_CONTEXT),
    )
    if (imported !== undefined && imported.fingerprint === fingerprintOf(carried))
      return Landed.AlreadyThere()
    if (
      imported === undefined &&
      !(yield* importedBeforeMarker(harness, existing.value.id, carried))
    )
      return yield* new CreatedByRuntime()
  }
  return yield* Effect.tryPromise({
    try: () =>
      harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          init: (tx, conversationId) =>
            write(
              tx,
              conversationId,
              carried,
              Option.map(existing, (conversation) => conversation.id),
            ),
        },
        BACKGROUND_CONTEXT,
      ),
    catch: (cause) => (cause instanceof HistoryInconsistent ? cause : new PiRejected({ cause })),
  }).pipe(Effect.as(Landed.Carried({ entries: carried.items.length })))
})
