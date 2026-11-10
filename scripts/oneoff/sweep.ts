import {
  RuntimeHistoryEntry,
  RuntimeHistoryInput,
  RuntimeHistoryThread,
  type PersonId,
} from '../../packages/contracts/src/index.ts'
import { Effect, Option, Result, Schema } from 'effect'
import { fold, Item, type Carried, type Attachments, type FoldFailure } from './fold.ts'
import {
  decodeRecords,
  type FlueRecord,
  type RecordInvalid,
  type RecordUnknown,
} from './records.ts'
import { FlueSource, type Listed, type Logged } from './source.ts'

/** A mismatched creator is refused before any Person receives that Thread's private history. */
class CreatorMismatch extends Schema.TaggedError<CreatorMismatch>()(
  'CreatorMismatch',
  { threadId: Schema.String },
  { title: 'Product and history creators differ' },
) {}

/** Every source batch is decoded before folding; no unknown event is silently discarded. */
const carriedOf = (
  stream: Listed,
  logged: Logged,
): Result.Result<Carried, FoldFailure | RecordInvalid | RecordUnknown> => {
  const records: FlueRecord[] = []
  for (const data of logged.batches) {
    const batch = decodeRecords(data)
    if (Result.isFailure(batch)) return Result.fail(batch.failure)
    records.push(...batch.success)
  }
  const [birth] = records
  const files: Attachments = new Map(
    logged.files
      .filter((file) => birth !== undefined && file.conversationId === birth.conversationId)
      .map((file) => [file.attachmentId, { mimeType: file.mimeType, bytes: file.bytes }]),
  )
  return fold(stream.threadId, records, files)
}

/** The old fold stays one-off; its output becomes the product route's native entry drafts. */
const historyThread = (carried: Carried, failures: Logged['failures']): RuntimeHistoryThread =>
  RuntimeHistoryThread.make({
    threadId: carried.threadId,
    origin: carried.origin,
    entries: carried.items.map((item) =>
      Item.$match(item, {
        Said: ({ message, submission }) => {
          const draft = { kind: 'pi.user', model: [message] }
          return Option.match(submission, {
            onNone: () => RuntimeHistoryEntry.cases.Entry.make({ draft }),
            onSome: (requestId) => RuntimeHistoryEntry.cases.Delivery.make({ draft, requestId }),
          })
        },
        Signalled: ({ message, data, submission }) => {
          const draft = { kind: 'vivid.signal', model: [message], data: { ...data } }
          return Option.match(submission, {
            onNone: () => RuntimeHistoryEntry.cases.Entry.make({ draft }),
            onSome: (requestId) => RuntimeHistoryEntry.cases.Delivery.make({ draft, requestId }),
          })
        },
        Ran: ({ inputs }) => RuntimeHistoryEntry.cases.Run.make({ inputs }),
        Replied: ({ message }) =>
          RuntimeHistoryEntry.cases.Entry.make({
            draft: { kind: 'pi.assistant', model: [message] },
          }),
        Answered: ({ message }) =>
          RuntimeHistoryEntry.cases.Entry.make({
            draft: { kind: 'pi.tool-result', model: [message], data: { diagnostics: [] } },
          }),
        Responded: ({ data, inputs }) =>
          RuntimeHistoryEntry.cases.Response.make({
            draft: { kind: 'vivid.response', data: { ...data } },
            inputs: inputs.map((input) => {
              const requestId = input.submission
              if (input.outcome === 'failed')
                return RuntimeHistoryInput.cases.failed.make({
                  requestId,
                  failure: Option.getOrNull(Option.fromUndefinedOr(failures.get(requestId))),
                })
              return RuntimeHistoryInput.make({ requestId, outcome: input.outcome })
            }),
          }),
      }),
    ),
  })

/** Group by the creator after validating every source stream. Deleted product Threads stay untouched. */
export const sweep = Effect.fn('HistoryReader.sweep')(function* () {
  const source = yield* FlueSource
  const people = new Map<PersonId, RuntimeHistoryThread[]>()
  for (const stream of yield* source.streams) {
    if (Option.isNone(stream.product)) {
      yield* Effect.logInfo('Deleted Thread left in source', { threadId: stream.threadId })
      continue
    }
    const person = stream.product.value
    const logged = yield* source.read(stream.path)
    const carried = yield* Effect.fromResult(carriedOf(stream, logged))
    if (carried.origin.creator !== person)
      return yield* new CreatorMismatch({ threadId: stream.threadId })
    const history = historyThread(carried, logged.failures)
    const threads = people.get(person)
    if (threads === undefined) people.set(person, [history])
    else threads.push(history)
  }
  return people
})
