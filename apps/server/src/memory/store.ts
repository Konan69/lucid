import * as NodeCrypto from 'node:crypto'
import {
  Memory,
  MemoryBrief,
  type MemoryPage,
  MemoryId,
  MemoryKind,
  MemoryScope,
  PersonId,
  PersonSummary,
  RunId,
  ThreadId,
  InvalidRequest,
  NotFound,
  ServiceUnavailable,
  Workspace,
  type Person,
  type RememberRequest,
  type CorrectMemoryRequest,
} from '@vivid/contracts'
import { pageOf } from './page.ts'
import {
  Array as Arr,
  Clock,
  Cache,
  Exit,
  Context,
  Effect,
  Layer,
  Option,
  Order,
  Schema,
  Semaphore,
} from 'effect'
import { isAdmin, summaryOf, type Actor } from '../auth/access.ts'
import { workspaceIn } from '../auth/session.ts'
import { Database, type DatabaseInfrastructureError } from '../database/client.ts'
import { canSee, findThread, requireThread, type StoredThread } from '../threads/access.ts'
import {
  MemoryExtraction,
  MemoryRelation,
  type MemoryCandidate,
  type ExtractionFailure,
} from './extract.js'
import { Embeddings, EmbeddingBatchMismatch, type EmbeddingFailure } from './embeddings.js'
import {
  HelixMemory,
  MemoryPartition,
  MemoryReceiptId,
  MemoryRecord,
  MemoryScopeKey,
  ReceiptedWrite,
  type BriefIdentity,
  type HelixFailure,
  type MemoryLink,
  type ReadScope,
  type ReceiptIdentity,
  type RecordIdentity,
} from './helix.js'

/** Internal scope carries the identity omitted by the presentation contract's Person case. */
export const MemoryLocation = Schema.TaggedUnion({
  Person: { personId: PersonId },
  Company: {},
  Thread: { threadId: ThreadId, title: Schema.String },
})
export type MemoryLocation = typeof MemoryLocation.Type
export const RememberInput = Schema.Struct({
  partition: MemoryPartition,
  scope: MemoryLocation,
  kind: MemoryKind,
  content: Schema.NonEmptyString,
  aliases: Schema.Array(Schema.String),
  learnedIn: Schema.NullOr(ThreadId),
  learnedFrom: PersonSummary,
})
export type RememberInput = typeof RememberInput.Type
export const RememberResult = Schema.TaggedUnion({
  Stored: { memory: Memory },
  Reinforced: { memory: Memory },
})
export type RememberResult = typeof RememberResult.Type
/**
 * One positioned candidate of one Run. The learning lifecycle assigns `position` to each extracted
 * candidate before selection and keeps it through filtering and reordering, so a replay of the
 * same Run names the same candidate by the same key.
 */
export const LearnKey = Schema.Struct({
  runId: RunId,
  position: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export type LearnKey = typeof LearnKey.Type

/**
 * Where a candidate is written. It is resolved and authorized once (`MemoryAccess.destination`),
 * checkpointed by the lifecycle before the first write, and passed back unchanged on a replay.
 *
 * It is never recomputed on replay: a Thread made private between two attempts would move a
 * candidate from the Company partition to the Person's, miss its receipt there and write twice
 * (found in review of the M1 design, 4 Oct 2026).
 */
export const LearnDestination = Schema.Struct({
  partition: MemoryPartition,
  scope: MemoryLocation,
  learnedIn: Schema.NullOr(ThreadId),
})
export type LearnDestination = typeof LearnDestination.Type

/**
 * What applying one candidate did.
 *
 * - `Saved`: this call applied it.
 * - `AlreadySaved`: an earlier attempt applied it, and the memory it wrote is still current and
 *   readable by this actor.
 * - `AlreadyApplied`: an earlier attempt applied it, but that memory has since been forgotten or
 *   replaced, or this actor may no longer read it. No knowledge is returned.
 * - `Skipped`: the candidate is not to be stored. Nothing was written, and no receipt exists.
 */
export const LearnResult = Schema.TaggedUnion({
  Saved: { memory: Memory },
  AlreadySaved: { memory: Memory },
  AlreadyApplied: {},
  Skipped: {},
})
export type LearnResult = typeof LearnResult.Type

/**
 * The checkpointed destination is not where this actor would write the candidate now. The
 * candidate is not moved to the new destination: that could widen or narrow who can read it.
 */
export class DestinationChanged extends Schema.TaggedError<DestinationChanged>()(
  'MemoryDestinationChanged',
  {},
  { title: 'MemoryDestinationChanged' },
) {}

/**
 * A receipted store write: applied now, with the memory as persisted, or recorded by an earlier
 * attempt, with only the identity that attempt wrote to (its present state is the caller's to check).
 */
export const OnceResult = Schema.TaggedUnion({
  Applied: { memory: Memory },
  Recorded: { memoryId: MemoryId },
})
export type OnceResult = typeof OnceResult.Type

export class MemoryNotFound extends Schema.TaggedError<MemoryNotFound>()(
  'MemoryNotFound',
  { partition: MemoryPartition, id: MemoryId },
  { title: 'MemoryNotFound' },
) {}
export class InvalidMemoryLimit extends Schema.TaggedError<InvalidMemoryLimit>()(
  'InvalidMemoryLimit',
  { limit: Schema.Number },
  { title: 'InvalidMemoryLimit' },
) {}
export type MemoryFailure = EmbeddingFailure | HelixFailure | MemoryNotFound | InvalidMemoryLimit

/** Corrections preserve scope but attribute the replacement to its actual correcting exchange. */
export interface CorrectionInput extends RecordIdentity {
  readonly content: string
  readonly learnedFrom: PersonSummary
  readonly learnedIn: ThreadId | null
}

export interface RecallInput extends ReadScope {
  readonly query: string
  readonly limit: number
}
export interface ScoredMemory {
  readonly memory: Memory
  readonly score: number
}
export interface MemoryStoreService {
  readonly get: (input: RecordIdentity) => Effect.Effect<Option.Option<Memory>, MemoryFailure>
  readonly reinforce: (
    input: RecordIdentity & { readonly aliases: ReadonlyArray<string> },
  ) => Effect.Effect<Memory, MemoryFailure>
  readonly recallRanked: (
    input: RecallInput,
  ) => Effect.Effect<ReadonlyArray<ScoredMemory>, MemoryFailure>
  readonly link: (input: MemoryLink) => Effect.Effect<void, MemoryFailure>
  readonly remember: (input: RememberInput) => Effect.Effect<RememberResult, MemoryFailure>
  readonly correct: (input: CorrectionInput) => Effect.Effect<Memory, MemoryFailure>
  readonly forget: (input: RecordIdentity) => Effect.Effect<void, MemoryFailure>
  /** The memory an earlier attempt at this candidate wrote to, if one did. */
  readonly receipt: (
    input: ReceiptIdentity,
  ) => Effect.Effect<Option.Option<MemoryId>, MemoryFailure>
  /** `remember` with a receipt; `extends` links the saved statement to a record of this partition. */
  readonly rememberOnce: (
    input: ReceiptIdentity & {
      readonly statement: RememberInput
      readonly extends: Option.Option<MemoryId>
    },
  ) => Effect.Effect<OnceResult, MemoryFailure>
  /** `reinforce` with a receipt. */
  readonly reinforceOnce: (
    input: ReceiptIdentity & {
      readonly id: MemoryId
      readonly aliases: ReadonlyArray<string>
    },
  ) => Effect.Effect<OnceResult, MemoryFailure>
  /** `correct` with a receipt. */
  readonly correctOnce: (
    input: ReceiptIdentity & { readonly correction: CorrectionInput },
  ) => Effect.Effect<OnceResult, MemoryFailure>
  readonly recall: (input: RecallInput) => Effect.Effect<ReadonlyArray<Memory>, MemoryFailure>
  readonly list: (input: ReadScope) => Effect.Effect<ReadonlyArray<Memory>, MemoryFailure>
  readonly brief: {
    readonly get: (
      input: BriefIdentity & ReadScope,
    ) => Effect.Effect<Option.Option<MemoryBrief>, MemoryFailure>
    readonly put: (
      input: BriefIdentity & { readonly text: string },
    ) => Effect.Effect<MemoryBrief, MemoryFailure>
  }
}
export class MemoryStore extends Context.Service<MemoryStore, MemoryStoreService>()(
  'vivid/MemoryStore',
) {}

interface ScopedLocation {
  readonly key: MemoryScopeKey
  readonly scope: MemoryScope
}

/** Rendered scope and storage scope derive exhaustively from the same location value. */
function location(scope: MemoryLocation): ScopedLocation {
  return MemoryLocation.match(scope, {
    Person: ({ personId }): ScopedLocation => ({
      key: MemoryScopeKey.make(`person:${personId}`),
      scope: MemoryScope.cases.Person.make({}),
    }),
    Company: () => ({
      key: MemoryScopeKey.make('company'),
      scope: MemoryScope.cases.Company.make({}),
    }),
    Thread: ({ threadId, title }) => ({
      key: MemoryScopeKey.make(`thread:${threadId}`),
      scope: MemoryScope.cases.Thread.make({ threadId, title }),
    }),
  })
}

/** Collapse formatting differences without erasing names, numbers, negation, or sentence content. */
function statement(content: string) {
  return content.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Near-identical means the same words reordered plus close vectors; similarity alone must not swallow corrections. */
function duplicate(content: string, search: AwaitedSearch) {
  const exact = search.keyword.find(
    (hit) => statement(hit.record.memory.content) === statement(content),
  )
  if (exact !== undefined) return Option.some(exact.record)
  const words = Arr.sort(statement(content).split(' '), Order.String).join(' ')
  return Option.map(
    Option.fromUndefinedOr(
      search.vector.find(
        (hit) =>
          statement(hit.record.memory.content) === statement(content) ||
          (hit.distance < 0.02 &&
            Arr.sort(statement(hit.record.memory.content).split(' '), Order.String).join(' ') ===
              words),
      ),
    ),
    (hit) => hit.record,
  )
}
type AwaitedSearch = Effect.Success<ReturnType<HelixMemory['Service']['search']>>

/** RRF combines independent keyword and semantic ranks; stable identity prevents repeated hits and neighbors. */
function fuse(search: AwaitedSearch) {
  const scores = new Map<MemoryId, { record: MemoryRecord; score: number }>()
  const lists = [search.vector.map((hit) => hit.record), search.keyword.map((hit) => hit.record)]
  for (const list of lists) {
    for (const [index, record] of list.entries()) {
      const previous = scores.get(record.memory.id)
      const score = 1 / (60 + index + 1)
      if (previous === undefined) scores.set(record.memory.id, { record, score })
      else previous.score += score
    }
  }
  return Arr.sortWith(scores.values(), (hit) => hit.score, Order.flip(Order.Number))
}

/** A missing latest record is explicit: corrections and forgetting never silently invent or resurrect state. */
const requireRecord = Effect.fn('MemoryStore.requireRecord')(function* (
  helix: HelixMemory['Service'],
  input: RecordIdentity,
) {
  const record = yield* helix.get(input)
  if (Option.isNone(record)) return yield* Effect.fail(MemoryNotFound.make(input))
  return record.value
})

/** The provider contract promises one vector per text; preserve a precise error if an injected adapter violates it. */
const embedOne = Effect.fn('MemoryStore.embedOne')(function* (
  embeddings: Embeddings['Service'],
  text: string,
) {
  const vectors = yield* embeddings.embed([text])
  const vector = Arr.head(vectors)
  if (Option.isNone(vector))
    return yield* Effect.fail(EmbeddingBatchMismatch.make({ expected: 1, actual: vectors.length }))
  return vector.value
})

/** Remember serializes reconciliation and writes within this store, preserving duplicate identity during concurrent calls. */
const remembering = Effect.fn('MemoryStore.remember')(function* (
  dependencies: {
    readonly helix: HelixMemory['Service']
    readonly embeddings: Embeddings['Service']
  },
  input: RememberInput,
) {
  const { helix, embeddings } = dependencies
  const scoped = location(input.scope)
  const embedding = yield* embedOne(embeddings, input.content)
  const candidates = yield* helix.search({
    partition: input.partition,
    scopes: [scoped.key],
    query: input.content,
    embedding,
    limit: 12,
  })
  const existing = duplicate(input.content, candidates)
  const now = yield* Clock.currentTimeMillis
  if (Option.isSome(existing)) {
    const memory = Memory.make({ ...existing.value.memory, updatedAt: now })
    yield* helix.reinforce({
      partition: input.partition,
      record: MemoryRecord.make({
        memory,
        scope: existing.value.scope,
        aliases: Arr.dedupe([...existing.value.aliases, ...input.aliases]),
      }),
    })
    return RememberResult.cases.Reinforced.make({ memory })
  }
  const memory = Memory.make({
    id: MemoryId.make(NodeCrypto.randomUUID()),
    kind: input.kind,
    content: input.content,
    scope: scoped.scope,
    learnedIn: input.learnedIn,
    learnedFrom: input.learnedFrom,
    createdAt: now,
    updatedAt: now,
  })
  yield* helix.insert({
    partition: input.partition,
    record: MemoryRecord.make({ memory, aliases: input.aliases, scope: scoped.key }),
    embedding,
  })
  return RememberResult.cases.Stored.make({ memory })
})

/** Corrections create a new immutable statement and atomically link/invalidate the old version in Helix. */
const correcting = Effect.fn('MemoryStore.correct')(function* (
  dependencies: {
    readonly helix: HelixMemory['Service']
    readonly embeddings: Embeddings['Service']
  },
  input: CorrectionInput,
) {
  const previous = yield* requireRecord(dependencies.helix, input)
  const embedding = yield* embedOne(dependencies.embeddings, input.content)
  const now = yield* Clock.currentTimeMillis
  const memory = Memory.make({
    ...previous.memory,
    id: MemoryId.make(NodeCrypto.randomUUID()),
    content: input.content,
    learnedFrom: input.learnedFrom,
    learnedIn: input.learnedIn,
    createdAt: now,
    updatedAt: now,
  })
  yield* dependencies.helix.supersede({
    partition: input.partition,
    oldId: input.id,
    record: MemoryRecord.make({ memory, aliases: previous.aliases, scope: previous.scope }),
    embedding,
  })
  return memory
})

/**
 * Turn the adapter's answer into the store's. `Missing` means the record this write targeted
 * stopped being current between the store's read and the write: nothing was written and no receipt
 * exists, so it is the same precise failure as not finding the record in the first place.
 */
const onceResult = Effect.fn('MemoryStore.onceResult')(function* (
  written: ReceiptedWrite,
  applied: { readonly partition: MemoryPartition; readonly memory: Memory },
) {
  return yield* ReceiptedWrite.match<Effect.Effect<OnceResult, MemoryNotFound>>(written, {
    Applied: () => Effect.succeed(OnceResult.cases.Applied.make({ memory: applied.memory })),
    Recorded: ({ memoryId }) => Effect.succeed(OnceResult.cases.Recorded.make({ memoryId })),
    Missing: () =>
      Effect.fail(MemoryNotFound.make({ partition: applied.partition, id: applied.memory.id })),
  })
})

/**
 * `remember`, receipted. Reconciliation is the same as `remembering`: a statement that already
 * exists is reinforced, not stored twice. Whichever branch runs, the change, the EXTENDS edge and
 * the receipt commit in one Helix batch, and the receipt names the memory actually written to, so
 * a replay returns the deduplicated record and not a second copy.
 */
const rememberingOnce = Effect.fn('MemoryStore.rememberOnce')(function* (
  dependencies: {
    readonly helix: HelixMemory['Service']
    readonly embeddings: Embeddings['Service']
  },
  input: ReceiptIdentity & {
    readonly statement: RememberInput
    readonly extends: Option.Option<MemoryId>
  },
) {
  const { helix, embeddings } = dependencies
  const { statement: said, partition, receiptId } = input
  const scoped = location(said.scope)
  const embedding = yield* embedOne(embeddings, said.content)
  const candidates = yield* helix.search({
    partition,
    scopes: [scoped.key],
    query: said.content,
    embedding,
    limit: 12,
  })
  const existing = duplicate(said.content, candidates)
  const now = yield* Clock.currentTimeMillis
  if (Option.isSome(existing)) {
    const memory = Memory.make({ ...existing.value.memory, updatedAt: now })
    const written = yield* helix.reinforceOnce({
      partition,
      receiptId,
      record: MemoryRecord.make({
        memory,
        scope: existing.value.scope,
        aliases: Arr.dedupe([...existing.value.aliases, ...said.aliases]),
      }),
      // A statement cannot extend itself; the relation named the record this one deduplicated to.
      extends: Option.filter(input.extends, (id) => id !== memory.id),
    })
    return yield* onceResult(written, { partition, memory })
  }
  const memory = Memory.make({
    id: MemoryId.make(NodeCrypto.randomUUID()),
    kind: said.kind,
    content: said.content,
    scope: scoped.scope,
    learnedIn: said.learnedIn,
    learnedFrom: said.learnedFrom,
    createdAt: now,
    updatedAt: now,
  })
  const written = yield* helix.insertOnce({
    partition,
    receiptId,
    record: MemoryRecord.make({ memory, aliases: said.aliases, scope: scoped.key }),
    embedding,
    extends: input.extends,
  })
  return yield* onceResult(written, { partition, memory })
})

/** `reinforce`, receipted: the count rises and the aliases merge once per candidate, not per attempt. */
const reinforcingOnce = Effect.fn('MemoryStore.reinforceOnce')(function* (
  helix: HelixMemory['Service'],
  input: ReceiptIdentity & { readonly id: MemoryId; readonly aliases: ReadonlyArray<string> },
) {
  const previous = yield* requireRecord(helix, input)
  const memory = Memory.make({ ...previous.memory, updatedAt: yield* Clock.currentTimeMillis })
  const written = yield* helix.reinforceOnce({
    partition: input.partition,
    receiptId: input.receiptId,
    record: MemoryRecord.make({
      ...previous,
      memory,
      aliases: Arr.dedupe([...previous.aliases, ...input.aliases]),
    }),
    extends: Option.none(),
  })
  return yield* onceResult(written, { partition: input.partition, memory })
})

/** `correct`, receipted: the replacement, the invalidated old version and the receipt commit together. */
const correctingOnce = Effect.fn('MemoryStore.correctOnce')(function* (
  dependencies: {
    readonly helix: HelixMemory['Service']
    readonly embeddings: Embeddings['Service']
  },
  input: ReceiptIdentity & { readonly correction: CorrectionInput },
) {
  const { correction } = input
  const previous = yield* requireRecord(dependencies.helix, correction)
  const embedding = yield* embedOne(dependencies.embeddings, correction.content)
  const now = yield* Clock.currentTimeMillis
  const memory = Memory.make({
    ...previous.memory,
    id: MemoryId.make(NodeCrypto.randomUUID()),
    content: correction.content,
    learnedFrom: correction.learnedFrom,
    learnedIn: correction.learnedIn,
    createdAt: now,
    updatedAt: now,
  })
  const written = yield* dependencies.helix.supersedeOnce({
    partition: input.partition,
    receiptId: input.receiptId,
    oldId: correction.id,
    record: MemoryRecord.make({ memory, aliases: previous.aliases, scope: previous.scope }),
    embedding,
  })
  // `Missing` names the record that was to be replaced, not the replacement that was never written.
  return yield* onceResult(written, { partition: input.partition, memory }).pipe(
    Effect.mapError(() => MemoryNotFound.make({ partition: input.partition, id: correction.id })),
  )
})

/** One-hop neighbors obey the same scopes and lifecycle as ranked seeds, and the caller's limit bounds the whole response. */
const recalling = Effect.fn('MemoryStore.recall')(function* (
  dependencies: {
    readonly helix: HelixMemory['Service']
    readonly embeddings: Embeddings['Service']
  },
  input: RecallInput,
) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    return yield* Effect.fail(InvalidMemoryLimit.make({ limit: input.limit }))
  if (input.scopes.length === 0) return []
  const embedding = yield* embedOne(dependencies.embeddings, input.query)
  const search = yield* dependencies.helix.search({
    ...input,
    embedding,
    limit: Math.min(100, input.limit * 2),
  })
  const ranked = fuse(search).slice(0, input.limit)
  const seeds = ranked.slice(0, Math.max(1, Math.ceil(input.limit * 0.75)))
  const related = yield* dependencies.helix.expand({
    partition: input.partition,
    scopes: input.scopes,
    ids: seeds.map((hit) => hit.record.memory.id),
    limit: input.limit,
  })
  const contextScore = seeds.length === 0 ? 0 : Math.min(...seeds.map((hit) => hit.score)) / 2
  const context = related.map((record) => ({ record, score: contextScore }))
  return Arr.dedupeWith(
    [...seeds, ...context, ...ranked],
    (a, b) => a.record.memory.id === b.record.memory.id,
  )
    .slice(0, input.limit)
    .map((hit) => ({ memory: hit.record.memory, score: hit.score }))
})

/** Persistence and embedding authority are acquired once; read scope policy remains entirely with the caller. */
export const memoryStoreLayer = Layer.effect(
  MemoryStore,
  Effect.gen(function* () {
    const helix = yield* HelixMemory
    const embeddings = yield* Embeddings
    const writes = yield* Semaphore.make(1)
    const dependencies = { helix, embeddings }
    return MemoryStore.of({
      /** Policy checks identities without broad listing or exposing alias/embedding metadata. */
      get: Effect.fn('MemoryStore.get')(function* (input) {
        return Option.map(yield* helix.get(input), (record) => record.memory)
      }),
      /** An explicit duplicate relation reinforces its existing identity even when wording is a paraphrase. */
      reinforce: Effect.fn('MemoryStore.reinforce')(
        function* (input) {
          const previous = yield* requireRecord(helix, input)
          const memory = Memory.make({
            ...previous.memory,
            updatedAt: yield* Clock.currentTimeMillis,
          })
          yield* helix.reinforce({
            partition: input.partition,
            record: MemoryRecord.make({
              ...previous,
              memory,
              aliases: Arr.dedupe([...previous.aliases, ...input.aliases]),
            }),
          })
          return memory
        },
        (effect) => writes.withPermit(effect),
      ),
      /** The writer proves both endpoints belong to this partition; read visibility is still caller-owned. */
      link: Effect.fn('MemoryStore.link')(function* (input) {
        yield* requireRecord(helix, { partition: input.partition, id: input.from })
        yield* requireRecord(helix, { partition: input.partition, id: input.to })
        yield* helix.link(input)
      }),
      /** Serialize reconciliation and writes so concurrent Runs share the existing statement identity. */
      remember: (input) => writes.withPermit(remembering(dependencies, input)),
      /** Corrections share the write permit with remembers to prevent stale reconciliation against replaced records. */
      correct: (input) => writes.withPermit(correcting(dependencies, input)),
      receipt: (input) => helix.receipt(input),
      /** Receipted writes share the write permit, so reconciliation sees this process's earlier writes. */
      rememberOnce: (input) => writes.withPermit(rememberingOnce(dependencies, input)),
      reinforceOnce: (input) => writes.withPermit(reinforcingOnce(helix, input)),
      correctOnce: (input) => writes.withPermit(correctingOnce(dependencies, input)),
      /** Read existence before tombstoning so missing or superseded IDs remain a precise domain failure. */
      forget: Effect.fn('MemoryStore.forget')(
        function* (input: RecordIdentity) {
          yield* requireRecord(helix, input)
          const now = yield* Clock.currentTimeMillis
          yield* helix.forget({ ...input, now })
        },
        (effect) => writes.withPermit(effect),
      ),
      /** Recall stays independent of the write permit so warm reads remain responsive. */
      recall: Effect.fn('MemoryStore.recall')(function* (input) {
        return (yield* recalling(dependencies, input)).map((hit) => hit.memory)
      }),
      recallRanked: (input) => recalling(dependencies, input),
      /** Return at most 200 current records, newest first, without internal vectors or lifecycle history. */
      list: Effect.fn('MemoryStore.list')(function* (input) {
        return (yield* helix.list(input)).map((record) => record.memory)
      }),
      brief: {
        /** No stored page is genuine absence; the caller chooses when to rebuild it. */
        get: Effect.fn('MemoryStore.brief.get')(function* (input) {
          return yield* helix.briefGet(input)
        }),
        /** Record the actual rebuild time so a Run can assess the page's freshness. */
        put: Effect.fn('MemoryStore.brief.put')(function* (input) {
          const now = yield* Clock.currentTimeMillis
          const brief = MemoryBrief.make({ text: input.text, updatedAt: now })
          yield* helix.briefPut({ ...input, brief })
          return brief
        }),
      },
    })
  }),
)

export type MemoryAccessFailure =
  | MemoryFailure
  | ExtractionFailure
  | DatabaseInfrastructureError
  | NotFound
  | InvalidRequest

export interface MemoryAccessService {
  readonly list: (actor: Actor) => Effect.Effect<ReadonlyArray<Memory>, MemoryAccessFailure>
  readonly brief: (actor: Actor) => Effect.Effect<MemoryBrief, MemoryAccessFailure>
  /** The stored facts themselves for the model's context; a store read and nothing else. */
  readonly page: (actor: Actor) => Effect.Effect<MemoryPage, MemoryAccessFailure>
  readonly recall: (
    actor: Actor,
    input: { readonly query: string; readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<Memory>, MemoryAccessFailure>
  readonly remember: (
    actor: Actor,
    input: RememberRequest,
  ) => Effect.Effect<Memory, MemoryAccessFailure>
  readonly correct: (
    actor: Actor,
    input: CorrectMemoryRequest,
  ) => Effect.Effect<Memory, MemoryAccessFailure>
  readonly forget: (actor: Actor, id: MemoryId) => Effect.Effect<Memory, MemoryAccessFailure>
  readonly learn: (
    actor: Actor,
    candidate: MemoryCandidate,
  ) => Effect.Effect<Option.Option<Memory>, MemoryAccessFailure>
  /**
   * Where `learnOnce` will write this candidate for this actor, authorization included. The
   * lifecycle checkpoints it before the first write. `None` exactly when `learnOnce` answers
   * `Skipped`, so a candidate that is not stored has no destination to checkpoint.
   */
  readonly destination: (
    actor: Actor,
    candidate: MemoryCandidate,
  ) => Effect.Effect<Option.Option<LearnDestination>, MemoryAccessFailure>
  /**
   * Apply one positioned candidate at most once, however often it is attempted. It will replace
   * `learn` when the learning lifecycle consumes it; until then both exist and `learn` is unchanged.
   */
  readonly learnOnce: (
    actor: Actor,
    input: LearnOnceInput,
  ) => Effect.Effect<LearnResult, MemoryAccessFailure | DestinationChanged>
  readonly actorFor: (
    thread: StoredThread,
    person: Person,
  ) => Effect.Effect<Actor, MemoryAccessFailure>
}

export interface LearnOnceInput {
  readonly candidate: MemoryCandidate
  readonly key: LearnKey
  readonly destination: LearnDestination
}

/** Calls and learning share one authority over visibility, ownership, and cross-partition ranking. */
export class MemoryAccess extends Context.Service<MemoryAccess, MemoryAccessService>()(
  'vivid/MemoryAccess',
) {}

/** Personal notes follow their Person; Company and Thread records use the explicit workspace. */
function personalScope(personId: PersonId): ReadScope {
  return {
    partition: MemoryPartition.make(`p-${personId}`),
    scopes: [MemoryScopeKey.make(`person:${personId}`)],
  }
}

/** A workspace partition is derived from ownership, never from the learning Person in a Company. */
function workspacePartition(actor: Actor) {
  return Workspace.match(actor.workspace, {
    Personal: () => personalScope(actor.person.id).partition,
    Company: ({ company }) => MemoryPartition.make(`c-${company.id}`),
  })
}

/** A stored Thread must belong to the Actor's explicit workspace before its memory can be read or edited. */
function inMemoryWorkspace(actor: Actor, thread: StoredThread) {
  return Workspace.match(actor.workspace, {
    Personal: () => thread.companyId === null && thread.personId === actor.person.id,
    Company: ({ company }) => thread.companyId === company.id,
  })
}

/** A Vivid call must still be in a visible Thread in the workspace its Actor names. */
const actingThread = Effect.fn('MemoryAccess.actingThread')(function* (actor: Actor) {
  if (actor.by === 'person') return Option.none<StoredThread>()
  if (Option.isNone(actor.threadId))
    return yield* Effect.fail(NotFound.make({ message: 'Thread not found' }))
  const thread = yield* requireThread(actor.threadId.value, actor.person.id)
  if (!inMemoryWorkspace(actor, thread))
    return yield* Effect.fail(NotFound.make({ message: 'Thread not found' }))
  return Option.some(thread)
})

/** Scope metadata contains no memory content; authorize each still-shared Thread before it enters a recall query. */
const visibleThreadScopes = Effect.fn('MemoryAccess.visibleThreads')(function* (
  helix: HelixMemory['Service'],
  actor: Actor,
) {
  const partition = workspacePartition(actor)
  const keys = yield* helix.scopes(partition)
  const visible: MemoryScopeKey[] = []
  for (const key of keys) {
    if (!key.startsWith('thread:')) continue
    const thread = yield* findThread(ThreadId.make(key.slice('thread:'.length)))
    if (Option.isNone(thread) || thread.value.audience === 'private') continue
    if (inMemoryWorkspace(actor, thread.value) && (yield* canSee(thread.value.id, actor.person.id)))
      visible.push(key)
  }
  return visible
})

/** Shared rooms have only their own scope and Company knowledge; private calls may read the Person's notes across workspaces. */
const readScopes = Effect.fn('MemoryAccess.readScopes')(function* (
  helix: HelixMemory['Service'],
  actor: Actor,
) {
  const thread = yield* actingThread(actor)
  const companyScopes = Workspace.match(actor.workspace, {
    Personal: () => [],
    Company: () => [MemoryScopeKey.make('company')],
  })
  if (Option.isSome(thread) && thread.value.audience !== 'private') {
    return [
      {
        partition: workspacePartition(actor),
        scopes: [MemoryScopeKey.make(`thread:${thread.value.id}`), ...companyScopes],
      },
    ]
  }
  const personal = personalScope(actor.person.id)
  if (Workspace.guards.Personal(actor.workspace)) return [personal]
  const threads = yield* visibleThreadScopes(helix, actor)
  return [
    personal,
    { partition: workspacePartition(actor), scopes: [...companyScopes, ...threads] },
  ]
})

interface WriteLocation {
  readonly partition: MemoryPartition
  readonly scope: MemoryLocation
  readonly learnedIn: ThreadId | null
}

/** Company intent is explicit; otherwise only a shared Vivid Thread changes the default personal destination. */
const writeLocation = Effect.fn('MemoryAccess.writeLocation')(function* (
  actor: Actor,
  forCompany: boolean,
) {
  const thread = yield* actingThread(actor)
  const learnedIn = Option.match(thread, { onNone: () => null, onSome: (value) => value.id })
  if (forCompany) {
    if (!Workspace.guards.Company(actor.workspace))
      return yield* Effect.fail(
        InvalidRequest.make({ message: 'Company memory needs a Company workspace' }),
      )
    return {
      partition: workspacePartition(actor),
      scope: MemoryLocation.cases.Company.make({}),
      learnedIn,
    }
  }
  if (Option.isSome(thread) && thread.value.audience !== 'private') {
    return {
      partition: workspacePartition(actor),
      scope: MemoryLocation.cases.Thread.make({
        threadId: thread.value.id,
        title: thread.value.title,
      }),
      learnedIn,
    }
  }
  return {
    partition: personalScope(actor.person.id).partition,
    scope: MemoryLocation.cases.Person.make({ personId: actor.person.id }),
    learnedIn,
  }
})

/** A visible id is still not writable Company knowledge unless this Person taught it or is an admin. */
function mayEdit(actor: Actor, memory: Memory) {
  return MemoryScope.match(memory.scope, {
    Person: () => true,
    Thread: () => true,
    Company: () =>
      memory.learnedFrom.id === actor.person.id ||
      (Workspace.guards.Company(actor.workspace) && isAdmin(actor.workspace.role)),
  })
}

/** Locate a related statement only inside the current read rule; extension links do not grant editing its target. */
const readableRecord = Effect.fn('MemoryAccess.readableRecord')(function* (
  dependencies: { readonly helix: HelixMemory['Service']; readonly store: MemoryStore['Service'] },
  actor: Actor,
  id: MemoryId,
) {
  const readable = yield* readScopes(dependencies.helix, actor)
  for (const read of readable) {
    const memory = yield* dependencies.store.get({ partition: read.partition, id })
    if (Option.isNone(memory)) continue
    const key = MemoryScope.match(memory.value.scope, {
      Person: () => MemoryScopeKey.make(`person:${actor.person.id}`),
      Company: () => MemoryScopeKey.make('company'),
      Thread: ({ threadId }) => MemoryScopeKey.make(`thread:${threadId}`),
    })
    if (read.scopes.includes(key)) return { partition: read.partition, memory: memory.value }
  }
  return yield* Effect.fail(NotFound.make({ message: 'Memory not found' }))
})

/** Ownership is independent of recall scope; a creator may edit formerly shared Thread knowledge after making its audience private. */
const mayWriteRecord = Effect.fn('MemoryAccess.mayWriteRecord')(function* (
  actor: Actor,
  input: {
    readonly partition: MemoryPartition
    readonly memory: Memory
    readonly room: Option.Option<StoredThread>
  },
) {
  const shared = Option.isSome(input.room) && input.room.value.audience !== 'private'
  return yield* MemoryScope.match(input.memory.scope, {
    Person: () =>
      Effect.succeed(!shared && input.partition === personalScope(actor.person.id).partition),
    Company: () =>
      Effect.succeed(
        Workspace.guards.Company(actor.workspace) &&
          input.partition === workspacePartition(actor) &&
          mayEdit(actor, input.memory),
      ),
    Thread: ({ threadId }) =>
      Effect.gen(function* () {
        if (input.partition !== workspacePartition(actor)) return false
        if (shared && Option.isSome(input.room) && threadId !== input.room.value.id) return false
        const thread = yield* findThread(threadId)
        return (
          Option.isSome(thread) &&
          inMemoryWorkspace(actor, thread.value) &&
          (yield* canSee(thread.value.id, actor.person.id))
        )
      }),
  })
})

/** Explicit edits probe only the Person and active workspace partitions and hide all unauthorized ids behind NotFound. */
const writable = Effect.fn('MemoryAccess.writable')(function* (
  dependencies: { readonly helix: HelixMemory['Service']; readonly store: MemoryStore['Service'] },
  actor: Actor,
  id: MemoryId,
) {
  const room = yield* actingThread(actor)
  const partitions =
    Option.isSome(room) && room.value.audience !== 'private'
      ? [workspacePartition(actor)]
      : Arr.dedupe([personalScope(actor.person.id).partition, workspacePartition(actor)])
  for (const partition of partitions) {
    const memory = yield* dependencies.store.get({ partition, id })
    if (Option.isNone(memory)) continue
    const permitted = yield* mayWriteRecord(actor, { partition, memory: memory.value, room })
    if (permitted) return { partition, memory: memory.value }
  }
  return yield* Effect.fail(NotFound.make({ message: 'Memory not found' }))
})

interface AccessDependencies {
  readonly helix: HelixMemory['Service']
  readonly store: MemoryStore['Service']
  readonly database: Database['Service']
}

/**
 * The newest records one authorized read returns; Helix bounds each partition's list at the same
 * number (`HelixMemory.list`). A read that comes back this long may have left older records
 * behind, which is what the page reports as `older`.
 */
const LIST_LIMIT = 200

/** Every policy program uses the captured database, while Actor remains a per-call value. */
function accessReads(dependencies: AccessDependencies) {
  const { store, helix, database } = dependencies
  return {
    /** Merge authorized partitions and return the `LIST_LIMIT` newest records across them. */
    list: Effect.fn('MemoryAccess.list')(
      function* (actor: Actor) {
        const scopes = yield* readScopes(helix, actor)
        const pages = yield* Effect.forEach(scopes, (scope) => store.list(scope))
        return Arr.sortWith(
          pages.flat(),
          (memory) => memory.createdAt,
          Order.flip(Order.Number),
        ).slice(0, LIST_LIMIT)
      },
      (effect) => Effect.provideService(effect, Database, database),
    ),
    /** Preserve actual RRF scores across partitions rather than concatenating personal results before Company results. */
    recall: Effect.fn('MemoryAccess.recall')(
      function* (actor: Actor, input: { readonly query: string; readonly limit: number }) {
        const scopes = yield* readScopes(helix, actor)
        const pages = yield* Effect.forEach(scopes, (scope) =>
          store.recallRanked({ ...scope, ...input }),
        )
        return Arr.sortWith(pages.flat(), (hit) => hit.score, Order.flip(Order.Number))
          .slice(0, input.limit)
          .map((hit) => hit.memory)
      },
      (effect) => Effect.provideService(effect, Database, database),
    ),
    /** Background learning re-reads Membership and Thread access after a Run, never trusting stale workspace or audience. */
    actorFor: Effect.fn('MemoryAccess.actorFor')(
      function* (thread: StoredThread, person: Person) {
        const current = yield* requireThread(thread.id, person.id)
        const workspace = yield* workspaceIn(person.id, Option.fromNullOr(current.companyId))
        return { person, workspace, by: 'vivid' as const, threadId: Option.some(current.id) }
      },
      (effect) => Effect.provideService(effect, Database, database),
    ),
  }
}

/** Attribute new memory once; the destination is already proven by the shared write rule. */
function rememberAt(
  store: MemoryStore['Service'],
  actor: Actor,
  destination: WriteLocation,
  candidate: Pick<MemoryCandidate, 'content' | 'kind' | 'aliases'>,
) {
  return store.remember(
    RememberInput.make({ ...destination, ...candidate, learnedFrom: summaryOf(actor.person) }),
  )
}

/** Calls preserve audit provenance and expose a forgotten record only internally so the handler can record its scope. */
function accessWrites(dependencies: AccessDependencies) {
  const { store, database } = dependencies
  return {
    /** No implicit Company sharing is inferred from membership or the workspace where this Person spoke. */
    remember: Effect.fn('MemoryAccess.remember')(
      function* (actor: Actor, input: RememberRequest) {
        const destination = yield* writeLocation(actor, input.forCompany)
        return (yield* rememberAt(store, actor, destination, {
          kind: input.kind,
          content: input.content,
          aliases: [],
        })).memory
      },
      (effect) => Effect.provideService(effect, Database, database),
    ),
    /** A correction shares the forgetting gate and records the correcting Person and current Thread. */
    correct: Effect.fn('MemoryAccess.correct')(
      function* (actor: Actor, input: CorrectMemoryRequest) {
        const target = yield* writable(dependencies, actor, input.id)
        return yield* store.correct({
          partition: target.partition,
          id: input.id,
          content: input.content,
          learnedFrom: summaryOf(actor.person),
          learnedIn: Option.getOrNull(actor.threadId),
        })
      },
      (effect) => Effect.provideService(effect, Database, database),
    ),
    /** Unauthorized Company ids are indistinguishable from missing ids and cannot trigger tombstones. */
    forget: Effect.fn('MemoryAccess.forget')(
      function* (actor: Actor, id: MemoryId) {
        const target = yield* writable(dependencies, actor, id)
        yield* store.forget({ partition: target.partition, id })
        return target.memory
      },
      (effect) => Effect.provideService(effect, Database, database),
    ),
  }
}

/** Matching both partition and rendered scope prevents a duplicate or update from inheriting a wider destination. */
function sameDestination(
  destination: WriteLocation,
  target: { readonly partition: MemoryPartition; readonly memory: Memory },
) {
  if (destination.partition !== target.partition) return false
  return MemoryScope.match(location(destination.scope).scope, {
    Person: () => MemoryScope.guards.Person(target.memory.scope),
    Company: () => MemoryScope.guards.Company(target.memory.scope),
    Thread: ({ threadId }) =>
      MemoryScope.guards.Thread(target.memory.scope) && target.memory.scope.threadId === threadId,
  })
}

/** An extension reads its target but only writes the new statement; even links cannot cross a partition. */
const extendCandidate = Effect.fn('MemoryAccess.extend')(function* (
  dependencies: AccessDependencies,
  input: {
    readonly actor: Actor
    readonly destination: WriteLocation
    readonly candidate: MemoryCandidate
    readonly id: MemoryId
  },
) {
  const target = yield* readableRecord(dependencies, input.actor, input.id)
  const saved = yield* rememberAt(
    dependencies.store,
    input.actor,
    input.destination,
    input.candidate,
  )
  if (target.partition === input.destination.partition && saved.memory.id !== target.memory.id)
    yield* dependencies.store.link({
      partition: target.partition,
      from: saved.memory.id,
      to: target.memory.id,
      kind: 'EXTENDS',
    })
  return Option.some(saved.memory)
})

/** Candidate identity reconciliation obeys the same destination as Remember; updates alone require permission to edit the existing statement. */
const learnCandidate = Effect.fn('MemoryAccess.learn')(function* (
  dependencies: AccessDependencies,
  actor: Actor,
  candidate: MemoryCandidate,
) {
  if (
    !candidate.shouldStore ||
    (candidate.forCompany && Workspace.guards.Personal(actor.workspace))
  )
    return Option.none<Memory>()
  const destination = yield* writeLocation(actor, candidate.forCompany)
  const { store } = dependencies
  // Each relation owns its authority check and write. A new relation must supply a handler,
  // rather than accidentally inheriting the previous fall-through correction operation.
  return yield* MemoryRelation.match<
    Effect.Effect<Option.Option<Memory>, MemoryAccessFailure, Database>
  >(candidate.relation, {
    new: () =>
      rememberAt(store, actor, destination, candidate).pipe(
        Effect.map((saved) => Option.some(saved.memory)),
      ),
    extends: ({ id }) => extendCandidate(dependencies, { actor, destination, candidate, id }),
    duplicate: ({ id }) =>
      Effect.gen(function* () {
        const target = yield* readableRecord(dependencies, actor, id)
        if (!sameDestination(destination, target))
          return Option.some((yield* rememberAt(store, actor, destination, candidate)).memory)
        return Option.some(
          yield* store.reinforce({
            partition: target.partition,
            id: target.memory.id,
            aliases: candidate.aliases,
          }),
        )
      }),
    updates: ({ id }) =>
      Effect.gen(function* () {
        const target = yield* writable(dependencies, actor, id)
        if (!sameDestination(destination, target))
          return yield* Effect.fail(
            InvalidRequest.make({ message: 'Memory relation crosses its write scope' }),
          )
        return Option.some(
          yield* store.correct({
            partition: target.partition,
            id: target.memory.id,
            content: candidate.content,
            learnedFrom: summaryOf(actor.person),
            learnedIn: Option.getOrNull(actor.threadId),
          }),
        )
      }),
  })
})

/** A candidate that is not to be stored: the same pure test `learn` applies before any read. */
function notStored(actor: Actor, candidate: MemoryCandidate) {
  return (
    !candidate.shouldStore || (candidate.forCompany && Workspace.guards.Personal(actor.workspace))
  )
}

/**
 * Whether the checkpointed destination is still where this actor writes the candidate. Partition
 * and storage scope decide who can read the memory, so both must match; a renamed Thread is the
 * same destination, so its title is not compared.
 */
function sameLocation(current: WriteLocation, checkpointed: LearnDestination) {
  return (
    current.partition === checkpointed.partition &&
    location(current.scope).key === location(checkpointed.scope).key
  )
}

/** Encoded once, at persistence egress, in the same form as the brief's identity. */
function receiptOf(destination: LearnDestination, key: LearnKey): ReceiptIdentity {
  return {
    partition: destination.partition,
    receiptId: MemoryReceiptId.make(
      JSON.stringify([destination.partition, key.runId, key.position]),
    ),
  }
}

/**
 * What an existing receipt means for this actor now. A receipt proves the candidate was applied;
 * it does not prove the memory still exists or that this actor may read it. `readableRecord`
 * applies today's read rule and lifecycle, so a memory forgotten, replaced or no longer visible
 * is reported as applied without returning it.
 */
const settled = Effect.fn('MemoryAccess.settled')(function* (
  dependencies: AccessDependencies,
  actor: Actor,
  memoryId: MemoryId,
) {
  return yield* readableRecord(dependencies, actor, memoryId).pipe(
    Effect.map((found) => LearnResult.cases.AlreadySaved.make({ memory: found.memory })),
    Effect.catchTag('NotFound', () => Effect.succeed(LearnResult.cases.AlreadyApplied.make({}))),
  )
})

interface AppliedOnce {
  readonly actor: Actor
  readonly candidate: MemoryCandidate
  readonly destination: LearnDestination
  readonly receipt: ReceiptIdentity
}

/** The candidate as a new statement at its destination, optionally extending a record there. */
function statedOnce(
  store: MemoryStore['Service'],
  input: AppliedOnce,
  target: Option.Option<MemoryId>,
) {
  return store.rememberOnce({
    ...input.receipt,
    statement: RememberInput.make({
      partition: input.destination.partition,
      scope: input.destination.scope,
      learnedIn: input.destination.learnedIn,
      kind: input.candidate.kind,
      content: input.candidate.content,
      aliases: input.candidate.aliases,
      learnedFrom: summaryOf(input.actor.person),
    }),
    extends: target,
  })
}

/**
 * Each relation keeps the authority check `learn` gives it and then makes exactly one receipted
 * write. An extension still only links inside its own partition; a duplicate outside the
 * destination is stored as a new statement; an update outside it is refused.
 */
const applyOnce = Effect.fn('MemoryAccess.applyOnce')(function* (
  dependencies: AccessDependencies,
  input: AppliedOnce,
) {
  const { store } = dependencies
  const { actor, candidate, destination, receipt } = input
  return yield* MemoryRelation.match<Effect.Effect<OnceResult, MemoryAccessFailure, Database>>(
    candidate.relation,
    {
      new: () => statedOnce(store, input, Option.none()),
      extends: ({ id }) =>
        Effect.gen(function* () {
          const target = yield* readableRecord(dependencies, actor, id)
          const within = target.partition === destination.partition
          return yield* statedOnce(
            store,
            input,
            within ? Option.some(target.memory.id) : Option.none(),
          )
        }),
      duplicate: ({ id }) =>
        Effect.gen(function* () {
          const target = yield* readableRecord(dependencies, actor, id)
          if (!sameDestination(destination, target))
            return yield* statedOnce(store, input, Option.none())
          return yield* store.reinforceOnce({
            ...receipt,
            id: target.memory.id,
            aliases: candidate.aliases,
          })
        }),
      updates: ({ id }) =>
        Effect.gen(function* () {
          const target = yield* writable(dependencies, actor, id)
          if (!sameDestination(destination, target))
            return yield* Effect.fail(
              InvalidRequest.make({ message: 'Memory relation crosses its write scope' }),
            )
          return yield* store.correctOnce({
            ...receipt,
            correction: {
              partition: target.partition,
              id: target.memory.id,
              content: candidate.content,
              learnedFrom: summaryOf(actor.person),
              learnedIn: destination.learnedIn,
            },
          })
        }),
    },
  )
})

/** The relation's one receipted write, answered for this actor. */
const attemptOnce = Effect.fn('MemoryAccess.attemptOnce')(function* (
  dependencies: AccessDependencies,
  input: AppliedOnce,
) {
  const written = yield* applyOnce(dependencies, input)
  return yield* OnceResult.match<Effect.Effect<LearnResult, MemoryAccessFailure, Database>>(
    written,
    {
      Applied: ({ memory }) => Effect.succeed(LearnResult.cases.Saved.make({ memory })),
      Recorded: ({ memoryId }) => settled(dependencies, input.actor, memoryId),
    },
  )
})

/**
 * Failures a competing attempt can explain, after which the whole ordered procedure is run again:
 * the relation's target is gone (a competing update replaced it before this attempt read it), or
 * Helix rolled this batch back because another write won (a transaction conflict, or the unique
 * receipt index; both measured as full rollbacks, artifacts/memory-learn/probe).
 */
const RERUN: ReadonlySet<string> = new Set([
  'NotFound',
  'MemoryNotFound',
  'MemoryHelixConflict',
  'MemoryHelixDuplicate',
])

/**
 * How many times the ordered procedure runs again after such a failure. One rerun finds a
 * competitor's receipt; the second covers a transaction conflict with an unrelated write, which
 * leaves no receipt and nothing written, so applying again is safe.
 */
const RERUNS = 2

/**
 * One pass, in the only permitted order: (1) this actor's CURRENT authority, and that the
 * checkpointed destination is still theirs, so a receipt is never read for an actor who has lost
 * access or whose destination moved; (2) the receipt, before any read of the relation's target,
 * because a successful update leaves its old target no longer current and a replay would otherwise
 * fail on it; (3) the relation's own authority check and its one receipted write.
 */
const orderedOnce = Effect.fn('MemoryAccess.orderedOnce')(function* (
  dependencies: AccessDependencies,
  actor: Actor,
  input: LearnOnceInput,
) {
  const current = yield* writeLocation(actor, input.candidate.forCompany)
  if (!sameLocation(current, input.destination))
    return yield* Effect.fail(DestinationChanged.make({}))
  const receipt = receiptOf(input.destination, input.key)
  const earlier = yield* dependencies.store.receipt(receipt)
  if (Option.isSome(earlier)) return yield* settled(dependencies, actor, earlier.value)
  return yield* attemptOnce(dependencies, {
    actor,
    candidate: input.candidate,
    destination: input.destination,
    receipt,
  })
})

/**
 * Apply one candidate at most once.
 *
 * After a failure that a competing attempt can explain, the WHOLE ordered pass runs again, never
 * only the receipt read: authority and destination are checked afresh before the receipt is read a
 * second time, so an actor who lost access or whose destination moved while the first pass ran gets
 * that failure and not an answer from the receipt (found in review of this implementation, 4 Oct
 * 2026). When the rerun finds no receipt it applies again and, if the target truly is absent, the
 * original failure stands; it is never turned into a success. Any other failure (an outage, a
 * timeout after the request was sent) is an unknown outcome and is returned as it is; the caller's
 * retry resolves it through the receipt.
 */
const learnOnce = Effect.fn('MemoryAccess.learnOnce')(function* (
  dependencies: AccessDependencies,
  actor: Actor,
  input: LearnOnceInput,
) {
  if (notStored(actor, input.candidate)) return LearnResult.cases.Skipped.make({})
  return yield* orderedOnce(dependencies, actor, input).pipe(
    Effect.retry({ times: RERUNS, while: (failure) => RERUN.has(failure._tag) }),
  )
})

/** Brief cache keys include the exact authorized current memories; changing audience, membership, or a statement cannot reuse a wider page. */
const makeAccess = Effect.fn('MemoryAccess.make')(function* () {
  const store = yield* MemoryStore
  const helix = yield* HelixMemory
  const database = yield* Database
  const extraction = yield* MemoryExtraction
  const dependencies = { store, helix, database }
  const reads = accessReads(dependencies)
  const pages = yield* Cache.makeWith(
    Effect.fn('MemoryAccess.summarize')(function* (input: {
      readonly memories: ReadonlyArray<Memory>
      readonly person: PersonSummary
    }) {
      const text = yield* extraction.summarize(input)
      return MemoryBrief.make({ text, updatedAt: yield* Clock.currentTimeMillis })
    }),
    {
      capacity: 128,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? '10 minutes' : 0),
    },
  )
  // Cache uses structural equality for keys: immutable schema values keep the full authorization snapshot in the key.
  return MemoryAccess.of({
    ...reads,
    ...accessWrites(dependencies),
    /** A shared room builds its own page from its allowed records; a personal persisted page never enters that room. */
    brief: Effect.fn('MemoryAccess.brief')(function* (actor: Actor) {
      const memories = yield* reads.list(actor)
      if (memories.length === 0) return MemoryBrief.make({ text: '', updatedAt: null })
      return yield* Cache.get(pages, { memories, person: summaryOf(actor.person) })
    }),
    /**
     * Built from the same authorized read as `list`, so a shared Thread's page holds only what
     * that Thread may see. No model and no cache: the brief above pays a completion whenever a
     * memory changes, and that wait used to sit in front of every reply.
     */
    page: Effect.fn('MemoryAccess.page')(function* (actor: Actor) {
      const memories = yield* reads.list(actor)
      return pageOf({ memories, truncated: memories.length >= LIST_LIMIT })
    }),
    destination: Effect.fn('MemoryAccess.destination')(
      function* (actor: Actor, candidate: MemoryCandidate) {
        if (notStored(actor, candidate)) return Option.none<LearnDestination>()
        return Option.some(LearnDestination.make(yield* writeLocation(actor, candidate.forCompany)))
      },
      (effect) => Effect.provideService(effect, Database, database),
    ),
    learnOnce: (actor, input) =>
      learnOnce(dependencies, actor, input).pipe(Effect.provideService(Database, database)),
    /** Candidate writes are evaluated individually so one rejected relation need not erase other useful notes. */
    learn: (actor, candidate) =>
      learnCandidate(dependencies, actor, candidate).pipe(
        Effect.provideService(Database, database),
      ),
  })
})

export const memoryAccessLayer = Layer.effect(MemoryAccess, makeAccess())

const unconfiguredMemory = Effect.fail(
  ServiceUnavailable.make({ service: 'memory', message: 'Memory is unconfigured' }),
)

/** Unconfigured installations retain callable handlers with a precise availability error instead of failing server startup. */
export const unavailableMemoryAccessLayer = Layer.succeed(
  MemoryAccess,
  MemoryAccess.of({
    list: Effect.fn('MemoryAccess.unconfigured.list')(() => unconfiguredMemory),
    brief: Effect.fn('MemoryAccess.unconfigured.brief')(() => unconfiguredMemory),
    page: Effect.fn('MemoryAccess.unconfigured.page')(() => unconfiguredMemory),
    destination: Effect.fn('MemoryAccess.unconfigured.destination')(() => unconfiguredMemory),
    learnOnce: Effect.fn('MemoryAccess.unconfigured.learnOnce')(() => unconfiguredMemory),
    recall: Effect.fn('MemoryAccess.unconfigured.recall')(() => unconfiguredMemory),
    remember: Effect.fn('MemoryAccess.unconfigured.remember')(() => unconfiguredMemory),
    correct: Effect.fn('MemoryAccess.unconfigured.correct')(() => unconfiguredMemory),
    forget: Effect.fn('MemoryAccess.unconfigured.forget')(() => unconfiguredMemory),
    learn: Effect.fn('MemoryAccess.unconfigured.learn')(() => unconfiguredMemory),
    actorFor: Effect.fn('MemoryAccess.unconfigured.actorFor')(() => unconfiguredMemory),
  }),
)
