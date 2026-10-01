import * as NodeCrypto from 'node:crypto'
import {
  Memory,
  MemoryBrief,
  MemoryId,
  MemoryKind,
  MemoryScope,
  PersonId,
  PersonSummary,
  ThreadId,
} from '@vivid/contracts'
import {
  Array as Arr,
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Order,
  Schema,
  Semaphore,
} from 'effect'
import { Embeddings, EmbeddingBatchMismatch, type EmbeddingFailure } from './embeddings.js'
import {
  HelixMemory,
  MemoryPartition,
  MemoryRecord,
  MemoryScopeKey,
  type BriefIdentity,
  type HelixFailure,
  type MemoryLink,
  type ReadScope,
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

export interface RecallInput extends ReadScope {
  readonly query: string
  readonly limit: number
}
export interface MemoryStoreService {
  readonly link: (input: MemoryLink) => Effect.Effect<void, MemoryFailure>
  readonly remember: (input: RememberInput) => Effect.Effect<RememberResult, MemoryFailure>
  readonly correct: (
    input: RecordIdentity & { readonly content: string },
  ) => Effect.Effect<Memory, MemoryFailure>
  readonly forget: (input: RecordIdentity) => Effect.Effect<void, MemoryFailure>
  readonly recall: (input: RecallInput) => Effect.Effect<ReadonlyArray<Memory>, MemoryFailure>
  readonly list: (input: ReadScope) => Effect.Effect<ReadonlyArray<Memory>, MemoryFailure>
  readonly brief: {
    readonly get: (input: BriefIdentity) => Effect.Effect<Option.Option<MemoryBrief>, MemoryFailure>
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
  return Arr.sortWith(scores.values(), (hit) => hit.score, Order.flip(Order.Number)).map(
    (hit) => hit.record,
  )
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
  input: RecordIdentity & { readonly content: string },
) {
  const previous = yield* requireRecord(dependencies.helix, input)
  const embedding = yield* embedOne(dependencies.embeddings, input.content)
  const now = yield* Clock.currentTimeMillis
  const memory = Memory.make({
    ...previous.memory,
    id: MemoryId.make(NodeCrypto.randomUUID()),
    content: input.content,
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
    ids: seeds.map((record) => record.memory.id),
    limit: input.limit,
  })
  return Arr.dedupeWith([...seeds, ...related, ...ranked], (a, b) => a.memory.id === b.memory.id)
    .slice(0, input.limit)
    .map((record) => record.memory)
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
      recall: (input) => recalling(dependencies, input),
      /** Expose current records without internal embeddings, alias metadata, or lifecycle history. */
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
