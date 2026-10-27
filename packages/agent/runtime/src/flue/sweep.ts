import type { PersonId, ThreadId } from '@vivid/contracts'
import { Effect, Option, Result, Schema } from 'effect'
import { HistoryInconsistent, Landed } from './carry.ts'
import {
  AnswerMissing,
  AttachmentMismatch,
  AttachmentMissing,
  AttachmentUnsupported,
  DeltaGap,
  fold,
  RecordOutOfPlace,
  RecoveryPairUnsupported,
  SignalUnreadable,
  StreamStartMissing,
  ToolBatchUnderStop,
  type Attachments,
  type Carried,
  type Kept,
} from './fold.ts'
import { decodeRecords, FlueRecord, RecordInvalid, RecordUnknown } from './records.ts'
import { FlueSource, type Listed, type Logged } from './source.ts'

/**
 * The Thread's creator in Flue's record of its birth is not the Person the product records for
 * it. The Thread would land in one of two Persons' stores, and choosing is not the import's call.
 */
export class CreatorMismatch extends Schema.TaggedError<CreatorMismatch>()(
  'CreatorMismatch',
  { threadId: Schema.String, flueCreator: Schema.String, productPerson: Schema.String },
  { title: 'Flue creator differs from the product Thread' },
) {
  override get message() {
    return `Thread ${this.threadId} was started by ${this.flueCreator} in Flue and belongs to ${this.productPerson} in the product`
  }
}

/** What happened to one stream; one JSON line each. Words of a Thread never appear here. */
export type Report =
  | {
      readonly outcome: 'carried'
      readonly threadId: ThreadId
      readonly personId: PersonId
      readonly entries: number
    }
  | {
      readonly outcome: 'already'
      readonly threadId: ThreadId
      readonly personId: PersonId
      readonly entries: 0
    }
  | {
      readonly outcome: 'skipped'
      readonly threadId: ThreadId
      readonly entries: 0
      readonly reason: 'no product Thread'
    }
  | {
      readonly outcome: 'failed'
      readonly threadId: ThreadId
      readonly personId: PersonId
      readonly entries: 0
      readonly reason: string
    }

/** How many streams ended each way. */
export interface Summary {
  readonly carried: number
  readonly already: number
  readonly skipped: number
  readonly failed: number
}

/** Failures whose `message` names only ids, types and counts, so it may be printed. */
const DESCRIBED = [
  RecordUnknown,
  RecordInvalid,
  StreamStartMissing,
  DeltaGap,
  RecordOutOfPlace,
  AttachmentMissing,
  AttachmentMismatch,
  AttachmentUnsupported,
  SignalUnreadable,
  RecoveryPairUnsupported,
  ToolBatchUnderStop,
  AnswerMissing,
  HistoryInconsistent,
  CreatorMismatch,
] as const

/**
 * Why a Thread failed, as printable text: its tag, and its own message when that is one of ours.
 * A storage or library failure's message can quote a statement or a value, so only its tag is told.
 */
const reasonOf = (error: { readonly _tag: string; readonly message: string }) =>
  DESCRIBED.some((kind) => error instanceof kind) ? `${error._tag}: ${error.message}` : error._tag

/** Every batch decoded, in `seq` order and then array order. */
function recordsOf(logged: Logged) {
  const records: Array<FlueRecord> = []
  for (const data of logged.batches) {
    const batch = decodeRecords(data)
    if (Result.isFailure(batch)) return Result.fail(batch.failure)
    records.push(...batch.success)
  }
  return Result.succeed(records)
}

/**
 * The files of the stream's root conversation, by id. Flue reads a file by its stream and
 * conversation together (`@flue/postgres` attachment store), so a file kept for another
 * conversation of the same stream is not this one's.
 */
function filesOf(logged: Logged, records: ReadonlyArray<FlueRecord>): Attachments {
  const [birth] = records
  const root = birth === undefined ? Option.none<string>() : Option.some(birth.conversationId)
  return new Map(
    logged.files
      .filter((file) => Option.contains(root, file.conversationId))
      .map((file): [string, Kept] => [
        file.attachmentId,
        { mimeType: file.mimeType, bytes: file.bytes },
      ]),
  )
}

/** One stream's log, decoded and folded. */
const carriedOf = (stream: Listed, logged: Logged) =>
  Result.flatMap(recordsOf(logged), (records) =>
    fold(stream.threadId, records, filesOf(logged, records)),
  )

/**
 * One stream with a product Thread: read, fold, check that Flue and the product agree on the
 * creator, then carry it into that Person's store.
 */
const carryOne = Effect.fn('Flue.carryOne')(function* <E, R>(
  stream: Listed,
  personId: PersonId,
  carryInto: (personId: PersonId, carried: Carried) => Effect.Effect<Landed, E, R>,
) {
  const logged = yield* (yield* FlueSource).read(stream.path)
  const carried = yield* Effect.fromResult(carriedOf(stream, logged))
  if (carried.origin.creator !== personId)
    return yield* new CreatorMismatch({
      threadId: stream.threadId,
      flueCreator: carried.origin.creator,
      productPerson: personId,
    })
  const landed = yield* carryInto(personId, carried)
  return Landed.$match(landed, {
    Carried: ({ entries }): Report => ({
      outcome: 'carried',
      threadId: stream.threadId,
      personId,
      entries,
    }),
    AlreadyThere: (): Report => ({
      outcome: 'already',
      threadId: stream.threadId,
      personId,
      entries: 0,
    }),
  })
})

/** One stream, whatever happens to it: a Thread that fails is reported and the next one goes on. */
const one = <E extends { readonly _tag: string; readonly message: string }, R>(
  stream: Listed,
  carryInto: (personId: PersonId, carried: Carried) => Effect.Effect<Landed, E, R>,
) =>
  Option.match(stream.product, {
    // A Thread deleted from the product: its log is not read at all.
    onNone: () =>
      Effect.succeed<Report>({
        outcome: 'skipped',
        threadId: stream.threadId,
        entries: 0,
        reason: 'no product Thread',
      }),
    onSome: (personId) =>
      carryOne(stream, personId, carryInto).pipe(
        Effect.catch((error) =>
          Effect.succeed<Report>({
            outcome: 'failed',
            threadId: stream.threadId,
            personId,
            entries: 0,
            reason: reasonOf(error),
          }),
        ),
      ),
  })

/**
 * Carry every Flue stream whose Thread still exists in the product into its creator's store, one
 * Thread at a time in path order, and report each. Running it again carries only what is not
 * there yet (`carry` is idempotent), so the same command serves a rehearsal and the cutover.
 * Listing the streams failing ends it; a Thread failing does not.
 */
export const sweep = Effect.fn('Flue.sweep')(function* <
  E extends { readonly _tag: string; readonly message: string },
  R,
>(
  carryInto: (personId: PersonId, carried: Carried) => Effect.Effect<Landed, E, R>,
  report: (line: Report) => Effect.Effect<void>,
) {
  const streams = yield* (yield* FlueSource).streams
  const counts = { carried: 0, already: 0, skipped: 0, failed: 0 }
  for (const stream of streams) {
    const line = yield* one(stream, carryInto)
    counts[line.outcome] += 1
    yield* report(line)
  }
  return counts satisfies Summary
})
