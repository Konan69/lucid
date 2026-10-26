import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  defineDocFamily,
  GenerationTask,
  hook,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Submission,
  type SubmissionId,
  type SubmissionRecord,
  type Tx,
} from '@earendil-works/pi-durable'
import { RuntimeSettlement, RuntimeSubmissionId } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { runInputs } from './deliveries.ts'
import { isDeliveryEntry } from './delivery.ts'
import { classify } from './failure.ts'
import { PiRejected, pi } from './threads.ts'

/**
 * What a response cost and when it ran: the facts main recorded as Flue message metadata
 * (`useResponseStart`, `useResponseFinish`) for the screens' timing line.
 */
export const ResponseData = Schema.Struct({
  /** `provider/model` of the response's last model message, the name `VIVID_MODEL` uses. */
  model: Schema.optionalKey(Schema.String),
  /** When the first delivery of the response was placed in the conversation. */
  startedAt: Schema.Finite,
  /** When the response's run settled. */
  finishedAt: Schema.Finite,
  toolCallCount: Schema.Int,
  /**
   * How the run ended, and the deliveries it answered with the entry each was placed as, oldest
   * first; the first one started the run and the others joined it. The transcript alone cannot
   * say either: Pi keeps a run's inputs only while it runs (`pi.live.run`), and a delivery placed
   * after a round of tools looks the same whether it joined that run or began the next. Absent
   * on entries written before these were recorded.
   */
  outcome: Schema.optionalKey(Schema.Literals(['completed', 'failed', 'aborted'])),
  inputs: Schema.optionalKey(
    Schema.Array(Schema.Struct({ submission: Schema.Int, entry: Schema.Int })),
  ),
  usage: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
    totalTokens: Schema.Finite,
    cost: Schema.Finite,
  }),
})
export interface ResponseData extends Schema.Schema.Type<typeof ResponseData> {}

/**
 * The transcript kind of a response's metadata: one entry of our own, appended when the run
 * settles. An entry and not a document, because it belongs at one place in the transcript (after
 * the answer it describes), is immutable like the answer, and reaches whatever reads the
 * transcript in order without a second lookup. It has no model message, so the model never sees
 * it and Pi appends it at once (a display-only write, Pi `src/harness/submissions.ts`).
 */
export const RESPONSE_ENTRY = 'vivid.response'

/**
 * The transcript kind of a run's own record of its deliveries: the submission and the entry of
 * each, oldest first. It is written before the run first asks the model and again whenever more
 * deliveries have joined, as a display-only entry Pi appends at once. Pi keeps a run's inputs
 * only while it runs (`pi.live.run`), and the transcript alone cannot say whether a delivery
 * placed after a round of tools joined that run or began the next; with this entry the run's
 * grouping and each message's submission are in the transcript from the run's start, not from
 * the moment after its end.
 */
export const RUN_ENTRY = 'vivid.run'
export const RunData = Schema.Struct({
  inputs: Schema.Array(Schema.Struct({ submission: Schema.Int, entry: Schema.Int })),
})
export interface RunData extends Schema.Schema.Type<typeof RunData> {}

/**
 * Which submission's response answered a submission that joined a response already going.
 * Written only for a response with more than one input, before it settles, so a settlement read
 * never has to guess; a submission without one answered itself. A fork is not a submission.
 */
export const Answered = defineDocFamily<{ by: number }, number>({
  // Pi 1.4.0 requires the policy; never writing a base keeps 1.2.0's behaviour (deltas only).
  checkpointWhen: () => false,
  kind: 'vivid.answered',
  version: 1,
  scope: 'conversation',
  family: true,
  history: 'latest',
  fork: 'initial',
  initial: (by) => ({ by }),
})

const PAGE = 256

/** The assistant message of a model entry, when it is one. */
const assistantOf = (entry: EntryRecord): Option.Option<AssistantMessage> => {
  if (!AssistantEntry.is(entry) || entry.model === undefined) return Option.none()
  const [message] = entry.model
  return message !== undefined && message.role === 'assistant'
    ? Option.some(message)
    : Option.none()
}

/** Every entry from `from` on, through `to` when the response has an answer, oldest first. */
const entriesBetween = Effect.fn('Response.entriesBetween')(function* (
  conversation: Conversation,
  from: EntryId,
  to: Option.Option<EntryId>,
) {
  const query = Option.match(to, {
    onNone: () => ({ minEntryId: from, order: 'ascending' as const }),
    onSome: (maxEntryId) => ({ minEntryId: from, maxEntryId, order: 'ascending' as const }),
  })
  const entries: EntryRecord[] = []
  let cursor = Option.none<Cursor>()
  for (;;) {
    const page = yield* pi(() =>
      conversation.entries(query, PAGE, Option.getOrUndefined(cursor), BACKGROUND_CONTEXT),
    )
    entries.push(...page.items)
    if (page.next === undefined) return entries
    cursor = Option.some(page.next)
  }
})

const add = (total: ResponseData['usage'], usage: Usage): ResponseData['usage'] => ({
  input: total.input + usage.input,
  output: total.output + usage.output,
  cacheRead: total.cacheRead + usage.cacheRead,
  cacheWrite: total.cacheWrite + usage.cacheWrite,
  totalTokens: total.totalTokens + usage.totalTokens,
  cost: total.cost + usage.cost.total,
})

/** The entries a delivery is placed as: a Person's words, or a signal. */
const isDelivery = (entry: EntryRecord) => isDeliveryEntry(entry.kind)

/**
 * Where a run that has no answer ends: before the first delivery that is not one of its own.
 * Runs do not overlap, so the next run's first entry is a committed boundary that needs no
 * record of its own, and a failed run is never measured with the work of the run after it.
 */
const ownEntries = (entries: ReadonlyArray<EntryRecord>, own: Option.Option<ReadonlySet<number>>) =>
  Option.match(own, {
    onNone: () => entries,
    onSome: (inputs) => {
      const next = entries.findIndex((entry) => isDelivery(entry) && !inputs.has(entry.id))
      return next === -1 ? entries : entries.slice(0, next)
    },
  })

/**
 * A response measured from what Pi committed, never from counters kept in memory: a response
 * that a restart interrupted is measured the same as one that was not. Every model message
 * between the first delivery's entry and the answer counts towards usage, failed attempts
 * included, as they do in Pi's own usage ledger. `own` names the run's deliveries when there is no answer to stop at.
 *
 * `reply` is the response's words as main's `readSubmissionReply` gave them (Flue 2.2.2
 * `replyFromSnapshot`): every text part of the response, across all its model turns, joined by
 * a blank line. Tool calls and results are not words.
 */
const measure = Effect.fn('Response.measure')(function* (
  conversation: Conversation,
  from: EntryId,
  to: Option.Option<EntryId>,
  own: Option.Option<ReadonlySet<number>>,
) {
  const entries = ownEntries(yield* entriesBetween(conversation, from, to), own)
  const messages = entries.flatMap((entry) => Option.toArray(assistantOf(entry)))
  const [first] = entries
  const opened = first === undefined || first.model === undefined ? undefined : first.model[0]
  // A provider attempt that failed, or that a stop cut short, was asked and paid for but is not a
  // step of the response: Pi commits it and then tries again (`generation.ts` `classify`), and
  // main left such an attempt out of the reply. Pi runs tool calls only from a message that
  // stopped to use tools, so only those calls happened.
  const steps = messages.filter(
    (message) => message.stopReason !== 'error' && message.stopReason !== 'aborted',
  )
  return {
    reply: steps
      .flatMap((message) =>
        message.content.flatMap((part) =>
          part.type === 'text' && part.text.length > 0 ? [part.text] : [],
        ),
      )
      .join('\n\n'),
    startedAt: opened === undefined ? Option.none<number>() : Option.some(opened.timestamp),
    model: Option.map(
      Option.fromUndefinedOr(messages.at(-1)),
      (message) => `${message.provider}/${message.model}`,
    ),
    toolCallCount: steps
      .filter((message) => message.stopReason === 'toolUse')
      .reduce(
        (count, message) =>
          count + message.content.filter((part) => part.type === 'toolCall').length,
        0,
      ),
    usage: messages.reduce((total, message) => add(total, message.usage), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
    }),
  }
})

/** Every input of a run settles the same way (`endRun`), so the first one's ending is the run's. */
export const outcomeOf = (record: SubmissionRecord) => {
  if (record.status === 'done') return 'completed' as const
  return record.status === 'unanswered' && record.reason === 'aborted'
    ? ('aborted' as const)
    : ('failed' as const)
}

/** The inputs one run settled together; `settled.ts` reads them from the settling commit. */
export interface SettledRun {
  readonly conversationId: ConversationId
  /** The run's placed inputs, oldest first. */
  readonly inputs: ReadonlyArray<SubmissionRecord & { readonly entry: EntryId }>
  readonly finishedAt: number
}

/**
 * Append the response's metadata entry. The request id names the run's first input, so writing
 * it twice (a replayed settlement) appends it once.
 */
export const recordResponse: (
  harness: Harness,
  run: SettledRun,
) => Effect.Effect<void, PiRejected> = Effect.fn('Response.record')(function* (
  harness: Harness,
  run: SettledRun,
) {
  const [first] = run.inputs
  if (first === undefined) return
  const conversation = yield* pi(() => harness.conversation(run.conversationId, BACKGROUND_CONTEXT))
  if (conversation === undefined) return
  const answer = Option.fromUndefinedOr(first.answer)
  const own = Option.some(new Set<number>(run.inputs.map((input) => input.entry)))
  const measured = yield* measure(conversation, first.entry, answer, own)
  const timed = {
    outcome: outcomeOf(first),
    inputs: run.inputs.map((input) => ({ submission: input.id, entry: input.entry })),
    startedAt: Option.getOrElse(measured.startedAt, () => run.finishedAt),
    finishedAt: run.finishedAt,
    toolCallCount: measured.toolCallCount,
    usage: measured.usage,
  }
  // A run that ended before any model message (stopped while still preparing) names no model.
  const data = Option.match(measured.model, {
    onNone: () => timed satisfies ResponseData,
    onSome: (model) => ({ ...timed, model }) satisfies ResponseData,
  })
  yield* pi(() =>
    conversation.submit(
      {
        type: 'write',
        entry: { kind: RESPONSE_ENTRY, data },
        requestId: `${RESPONSE_ENTRY}:${first.id}`,
      },
      BACKGROUND_CONTEXT,
    ),
  )
})

/** One commit names the first input as the answerer of every input that joined it. */
const nameAnswerer = (
  tx: Tx,
  conversationId: ConversationId,
  first: SubmissionId,
  joined: ReadonlyArray<SubmissionId>,
) =>
  Promise.all(
    joined.map((input) =>
      tx.doc(Answered, conversationId, String(input), first).then((answered) => {
        answered.by = first
      }),
    ),
  )

/**
 * What a run writes about itself as it goes. Before every request to the model it records its
 * deliveries (`vivid.run`). And before a response can settle it records which submission's
 * response the others joined: the two later hooks are the only places a run ends with an answer (Pi `src/harness/generation.ts`: `answer`
 * runs `onYield`, `finishToolRound` runs `afterTools`, and neither adds an input to the run
 * before it settles those it holds). A response with one input writes nothing.
 */
export const joinHooks = (
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  harness: Effect.Effect<Harness>,
) => {
  const record = (conversationId: ConversationId) =>
    run(
      Effect.gen(function* () {
        const opened = yield* harness
        const inputs = yield* runInputs(opened, conversationId)
        const [first, ...joined] = inputs
        if (first === undefined || joined.length === 0) return
        yield* pi(() =>
          opened.commit(
            (tx) => nameAnswerer(tx, conversationId, first, joined),
            BACKGROUND_CONTEXT,
          ),
        )
      }),
    )
  const describe = (conversationId: ConversationId) =>
    run(
      Effect.gen(function* () {
        const opened = yield* harness
        const inputs = yield* placedInputs(opened, conversationId)
        const [first] = inputs
        const conversation = yield* pi(() =>
          opened.conversation(conversationId, BACKGROUND_CONTEXT),
        )
        if (first === undefined || conversation === undefined) return
        yield* pi(() =>
          conversation.submit(
            {
              type: 'write',
              entry: { kind: RUN_ENTRY, data: { inputs } },
              // One entry per size the run has had: a retried request writes nothing new.
              requestId: `${RUN_ENTRY}:${first.submission}:${inputs.length}`,
            },
            BACKGROUND_CONTEXT,
          ),
        )
      }),
    )
  return hook(GenerationTask, {
    beforeRequest: (_request, api) => describe(api.conversationId).then(() => undefined),
    onYield: (_answer, api) => record(api.conversationId).then(() => undefined),
    afterTools: (_assistant, _results, api) => record(api.conversationId),
  })
}

/** The run's inputs with the entry each was placed as, in the order they were placed. */
const placedInputs = Effect.fn('Response.placedInputs')(function* (
  harness: Harness,
  conversationId: ConversationId,
) {
  const placed: Array<{ submission: number; entry: number }> = []
  for (const input of yield* runInputs(harness, conversationId)) {
    const submission = yield* pi(() => harness.submission(input, BACKGROUND_CONTEXT))
    if (submission === undefined) continue
    const record = yield* pi(() => submission.status(BACKGROUND_CONTEXT))
    if (record.entry !== undefined) placed.push({ submission: record.id, entry: record.entry })
  }
  return placed
})

const decodeId = Schema.decodeUnknownOption(RuntimeSubmissionId)

/**
 * Pi brands its ids in the type system only and exports no constructor, so a number is narrowed
 * by what Pi's ids are: positive integers. One that names nothing is refused by the lookup made
 * with it.
 */
export const isSubmissionId = (value: number): value is SubmissionId =>
  Number.isSafeInteger(value) && value > 0

/** Where the response that answered a submission began: its own entry, or its answerer's. */
const openingOf = Effect.fn('Response.openingOf')(function* (
  harness: Harness,
  record: Extract<SubmissionRecord, { type: 'input'; status: 'done' }>,
) {
  const joined = yield* pi(() =>
    harness.snapshot(Answered, record.conversationId, String(record.id), BACKGROUND_CONTEXT),
  )
  const own = { by: record.id, entry: record.entry }
  const by = joined === undefined ? record.id : joined.by
  if (by === record.id || !isSubmissionId(by)) return own
  const host = yield* pi(() => harness.submission(by, BACKGROUND_CONTEXT))
  if (host === undefined) return own
  const answerer = yield* pi(() => host.status(BACKGROUND_CONTEXT))
  return answerer.entry === undefined ? own : { by: answerer.id, entry: answerer.entry }
})

/**
 * A settled answer, read back from the transcript. A submission that joined a response is
 * answered by that whole response, so its reply and its tool count are read from where the
 * response began, not from where the submission was placed.
 */
const done = Effect.fn('Response.done')(function* (
  harness: Harness,
  record: Extract<SubmissionRecord, { type: 'input'; status: 'done' }>,
) {
  const opening = yield* openingOf(harness, record)
  const answeredBy = decodeId(opening.by)
  const conversation = yield* pi(() =>
    harness.conversation(record.conversationId, BACKGROUND_CONTEXT),
  )
  if (Option.isNone(answeredBy) || conversation === undefined) return Option.none()
  const measured = yield* measure(
    conversation,
    opening.entry,
    Option.some(record.answer),
    Option.none(),
  )
  return Option.some(
    RuntimeSettlement.cases.Done.make({
      answeredBy: answeredBy.value,
      reply: measured.reply,
      toolCalls: measured.toolCallCount,
    }),
  )
})

/**
 * An input that can no longer be answered. A stop is its own outcome; anything else is said in
 * the product's closed words (`failure.ts`), and the text Pi kept stays in the runtime.
 */
const unanswered = (record: Extract<SubmissionRecord, { status: 'unanswered' }>) => {
  if (record.reason === 'aborted') return RuntimeSettlement.cases.Stopped.make({})
  const { failure, status } = classify(record.reason, record.detail)
  return Option.match(status, {
    onNone: () => RuntimeSettlement.cases.Failed.make({ failure }),
    onSome: (code) => RuntimeSettlement.cases.Failed.make({ failure, status: code }),
  })
}

/** A submission of this conversation, or nothing: another conversation's number is unknown here. */
export const submissionOf: (
  harness: Harness,
  conversationId: ConversationId,
  id: SubmissionId,
) => Effect.Effect<Option.Option<Submission>, PiRejected> = Effect.fn('Response.submissionOf')(
  function* (harness: Harness, conversationId: ConversationId, id: SubmissionId) {
    const submission = yield* pi(() => harness.submission(id, BACKGROUND_CONTEXT))
    if (submission === undefined) return Option.none()
    const record = yield* pi(() => submission.status(BACKGROUND_CONTEXT))
    return record.conversationId === conversationId && record.type === 'input'
      ? Option.some(submission)
      : Option.none()
  },
)

/**
 * The committed status of one submission. With `wait` it is Pi's own wait: it resolves in the
 * commit that settles the submission, and interrupting this fiber cancels only the wait, never
 * the work (Pi `src/harness/submissions.ts` `wait`).
 */
export const settlement: (
  harness: Harness,
  submission: Submission,
  wait: boolean,
) => Effect.Effect<RuntimeSettlement, PiRejected> = Effect.fn('Response.settlement')(function* (
  harness: Harness,
  submission: Submission,
  wait: boolean,
) {
  const record = yield* wait
    ? Effect.tryPromise({
        try: (signal) => submission.wait(withAbortSignal(signal, BACKGROUND_CONTEXT)),
        catch: (cause) => new PiRejected({ cause }),
      })
    : pi(() => submission.status(BACKGROUND_CONTEXT))
  if (record.type !== 'input' || record.status === 'queued' || record.status === 'placed')
    return RuntimeSettlement.cases.Pending.make({})
  if (record.status === 'unanswered') return unanswered(record)
  return Option.getOrElse(yield* done(harness, record), () =>
    RuntimeSettlement.cases.Failed.make({ failure: 'Unexplained' }),
  )
})
