import {
  BatchCondition,
  Expr,
  IndexSpec,
  NodeRef,
  Order,
  Predicate,
  Projection,
  SourcePredicate,
  VectorDistanceMetric,
  defineParams,
  g,
  param,
  readBatch,
  writeBatch,
  QueryRequestType,
  type QueryRequest,
  type WriteBatch,
} from '@helix-db/helix-db'
import { Memory, MemoryBrief, MemoryId, PersonId, ServiceUnavailable } from '@vivid/contracts'
import { Context, Duration, Effect, Exit, Layer, Option, Schedule, Schema } from 'effect'
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { requiredSetting } from '../config.ts'
import { embeddingDimensions, embeddingModel, MemoryRateLimited } from './embeddings.js'

/** Partition and readable scope keys are separate authorities; no query derives additional scopes. */
export const MemoryPartition = Schema.String.check(Schema.isPattern(/^[pc]-.+$/)).pipe(
  Schema.brand('MemoryPartition'),
)
export type MemoryPartition = typeof MemoryPartition.Type
export const MemoryScopeKey = Schema.String.check(
  Schema.isPattern(/^(company|person:.+|thread:.+)$/),
).pipe(Schema.brand('MemoryScopeKey'))
export type MemoryScopeKey = typeof MemoryScopeKey.Type
export const MemoryRecord = Schema.Struct({
  memory: Memory,
  aliases: Schema.Array(Schema.String),
  scope: MemoryScopeKey,
})
export type MemoryRecord = typeof MemoryRecord.Type
const persistedRecord = Schema.fromJsonString(MemoryRecord)
const encodeRecord = Schema.encodeEffect(persistedRecord)
const Row = Schema.Struct({ record: persistedRecord })
const Rows = Schema.Struct({ records: Schema.Array(Row) })
const ScopeRows = Schema.Struct({ scopes: Schema.Array(Schema.Struct({ scope: MemoryScopeKey })) })
const decodeScopes = HttpClientResponse.schemaBodyJson(ScopeRows)
const SearchRows = Schema.Struct({
  vector: Schema.Array(Schema.Struct({ record: persistedRecord, distance: Schema.Number })),
  keyword: Schema.Array(Row),
})

export class HelixRejected extends Schema.TaggedError<HelixRejected>()(
  'MemoryHelixRejected',
  { status: Schema.Number },
  { title: 'MemoryHelixRejected' },
) {}
export class HelixConflict extends Schema.TaggedError<HelixConflict>()(
  'MemoryHelixConflict',
  {},
  { title: 'MemoryHelixConflict' },
) {}
/**
 * A unique index refused the write: another write already holds that unique value. Helix answers
 * HTTP 500 with error code `unique_constraint_violation` and rolls the whole batch back (measured
 * on helixdb v0.0.5, 20 of 20 trials). It is not an outage, so it is not `ServiceUnavailable`.
 */
export class HelixDuplicate extends Schema.TaggedError<HelixDuplicate>()(
  'MemoryHelixDuplicate',
  {},
  { title: 'MemoryHelixDuplicate' },
) {}
/**
 * An index this adapter depends on is not active. Helix accepts an index build and answers before
 * the index exists: until the build succeeds a unique index admits duplicates and a search fails
 * with `index_not_found` (both measured on helixdb v0.0.5, artifacts/memory-learn). A build can
 * also end blocked or aborted. `index` names it as `Label.property`.
 */
export class IndexUnready extends Schema.TaggedError<IndexUnready>()(
  'MemoryIndexUnready',
  { index: Schema.String, state: Schema.Literals(['pending', 'blocked', 'aborted']) },
  { title: 'MemoryIndexUnready' },
) {}
export class HelixMalformed extends Schema.TaggedError<HelixMalformed>()(
  'MemoryHelixMalformed',
  {},
  { title: 'MemoryHelixMalformed' },
) {}
export class MemoryIndexMismatch extends Schema.TaggedError<MemoryIndexMismatch>()(
  'MemoryIndexMismatch',
  {
    expectedModel: Schema.String,
    actualModel: Schema.String,
    expectedDimensions: Schema.Number,
    actualDimensions: Schema.Number,
  },
  { title: 'Memory embedding index configuration mismatch' },
) {}
export type HelixFailure =
  | MemoryIndexMismatch
  | ServiceUnavailable
  | MemoryRateLimited
  | HelixRejected
  | HelixConflict
  | HelixDuplicate
  | IndexUnready
  | HelixMalformed

export interface SearchInput {
  readonly partition: MemoryPartition
  readonly scopes: ReadonlyArray<MemoryScopeKey>
  readonly query: string
  readonly embedding: ReadonlyArray<number>
  readonly limit: number
}
export interface RecordIdentity {
  readonly partition: MemoryPartition
  readonly id: MemoryId
}
export interface ReadScope {
  readonly partition: MemoryPartition
  readonly scopes: ReadonlyArray<MemoryScopeKey>
}
export interface BriefIdentity {
  readonly partition: MemoryPartition
  readonly personId: PersonId
}

/**
 * The identity of one applied learning candidate: its destination partition, Run and position,
 * encoded once by the store. Helix keeps it unique, so two attempts at one candidate cannot both
 * commit (design and proof: the M1 receipt, reviewed 4 Oct 2026).
 */
export const MemoryReceiptId = Schema.String.pipe(Schema.brand('MemoryReceiptId'))
export type MemoryReceiptId = typeof MemoryReceiptId.Type
export interface ReceiptIdentity {
  readonly partition: MemoryPartition
  readonly receiptId: MemoryReceiptId
}

/**
 * What one receipted write did. The change and its receipt commit in one Helix write batch, so
 * exactly one of these is true afterwards.
 *
 * - `Applied`: this call made the change and wrote the receipt.
 * - `Recorded`: an earlier call already did; nothing was written now. `memoryId` is the memory
 *   that earlier call wrote to.
 * - `Missing`: no receipt exists and the record this write targets is no longer current, so
 *   nothing was written and no receipt was created.
 */
export const ReceiptedWrite = Schema.TaggedUnion({
  Applied: {},
  Recorded: { memoryId: MemoryId },
  Missing: {},
})
export type ReceiptedWrite = typeof ReceiptedWrite.Type

export const MemoryLinkKind = Schema.Literals(['EXTENDS', 'RELATES_TO'])
export type MemoryLinkKind = typeof MemoryLinkKind.Type
export interface MemoryLink {
  readonly partition: MemoryPartition
  readonly from: MemoryId
  readonly to: MemoryId
  readonly kind: MemoryLinkKind
}

export interface HelixMemoryService {
  readonly scopes: (
    partition: MemoryPartition,
  ) => Effect.Effect<ReadonlyArray<MemoryScopeKey>, HelixFailure>
  readonly link: (input: MemoryLink) => Effect.Effect<void, HelixFailure>
  readonly get: (input: RecordIdentity) => Effect.Effect<Option.Option<MemoryRecord>, HelixFailure>
  readonly list: (input: ReadScope) => Effect.Effect<ReadonlyArray<MemoryRecord>, HelixFailure>
  readonly search: (input: SearchInput) => Effect.Effect<typeof SearchRows.Type, HelixFailure>
  readonly expand: (
    input: ReadScope & { readonly ids: ReadonlyArray<MemoryId>; readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<MemoryRecord>, HelixFailure>
  readonly insert: (input: {
    readonly partition: MemoryPartition
    readonly record: MemoryRecord
    readonly embedding: ReadonlyArray<number>
  }) => Effect.Effect<void, HelixFailure>
  readonly reinforce: (input: {
    readonly partition: MemoryPartition
    readonly record: MemoryRecord
  }) => Effect.Effect<void, HelixFailure>
  readonly supersede: (input: {
    readonly partition: MemoryPartition
    readonly oldId: MemoryId
    readonly record: MemoryRecord
    readonly embedding: ReadonlyArray<number>
  }) => Effect.Effect<void, HelixFailure>
  readonly forget: (
    input: RecordIdentity & { readonly now: number },
  ) => Effect.Effect<void, HelixFailure>
  /** The memory an earlier attempt at this candidate wrote to, whatever that memory's state now. */
  readonly receipt: (input: ReceiptIdentity) => Effect.Effect<Option.Option<MemoryId>, HelixFailure>
  /**
   * Create a record, its receipt and, when `extends` names a current record of this partition
   * other than the new one, the EXTENDS edge from the new record to it: one batch.
   */
  readonly insertOnce: (
    input: ReceiptIdentity & {
      readonly record: MemoryRecord
      readonly embedding: ReadonlyArray<number>
      readonly extends: Option.Option<MemoryId>
    },
  ) => Effect.Effect<ReceiptedWrite, HelixFailure>
  /**
   * Reinforce an existing current record, write its receipt and, when `extends` names another
   * current record of this partition, the EXTENDS edge from the reinforced record to it: one
   * batch. `Missing` when the record is no longer current.
   */
  readonly reinforceOnce: (
    input: ReceiptIdentity & {
      readonly record: MemoryRecord
      readonly extends: Option.Option<MemoryId>
    },
  ) => Effect.Effect<ReceiptedWrite, HelixFailure>
  /** Replace a current record and write the receipt in one batch. `Missing` when it is no longer current. */
  readonly supersedeOnce: (
    input: ReceiptIdentity & {
      readonly oldId: MemoryId
      readonly record: MemoryRecord
      readonly embedding: ReadonlyArray<number>
    },
  ) => Effect.Effect<ReceiptedWrite, HelixFailure>
  readonly briefGet: (
    input: BriefIdentity & ReadScope,
  ) => Effect.Effect<Option.Option<MemoryBrief>, HelixFailure>
  readonly briefPut: (
    input: BriefIdentity & { readonly brief: MemoryBrief },
  ) => Effect.Effect<void, HelixFailure>
}
export class HelixMemory extends Context.Service<HelixMemory, HelixMemoryService>()(
  'vivid/HelixMemory',
) {}

const projection = [Projection.property('payload', 'record')]
const searchParams = defineParams({
  partition: param.string(),
  scopes: param.array(param.string()),
  query: param.string(),
  embedding: param.array(param.f32()),
  limit: param.i64(),
})

/** Lifecycle predicates precede search and graph limits so old or unauthorized records never consume top-k. */
function current() {
  return Predicate.and([
    Predicate.eq('isLatest', true),
    Predicate.isNull('validTo'),
    Predicate.isNull('deletedAt'),
  ])
}

/** The indexed tenant anchor and explicit scope membership constrain every recall surface. */
function visible(input: ReadScope) {
  return g()
    .nWithLabelWhere('Memory', SourcePredicate.eq('tenant_id', input.partition))
    .where(Predicate.and([Predicate.isIn('scope', [...input.scopes]), current()]))
}

/** Exact record lookups remain tenant-qualified even when memory IDs are globally unique. */
function identified(input: RecordIdentity) {
  return g()
    .nWithLabelWhere('Memory', SourcePredicate.eq('memoryId', input.id))
    .where(Predicate.and([Predicate.eq('tenant_id', input.partition), current()]))
}

const decodeUniqueViolation = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ error: Schema.Literal('unique_constraint_violation') }),
)

/** One attempt. The published SDK supplies the AST; Effect HttpClient owns transport and response validation. */
const requestHelix = Effect.fn('HelixMemory.request')(function* (
  client: HttpClient.HttpClient,
  url: string,
  query: QueryRequest,
) {
  const body = HttpClientRequest.bodyText(
    HttpClientRequest.post(`${url}/v2/query`),
    query.toJsonString(),
    'application/json',
  )
  const request =
    query.requestType === QueryRequestType.Write
      ? HttpClientRequest.setHeader(body, 'x-helix-await-durable', 'true')
      : body
  const response = yield* client
    .execute(request)
    .pipe(
      Effect.mapError(() =>
        ServiceUnavailable.make({ service: 'memory', message: 'HelixDB is unreachable' }),
      ),
    )
  if (response.status === 409) return yield* Effect.fail(HelixConflict.make({}))
  if (response.status === 429)
    return yield* Effect.fail(
      MemoryRateLimited.make({
        service: 'memory',
        message: 'HelixDB rate limited memory',
        retryAfter: Option.getOrNull(Headers.get(response.headers, 'retry-after')),
      }),
    )
  if (response.status === 500) {
    // probe/ready.mjs proves this stable code denotes rollback, rather than an unknown outage.
    const duplicate = yield* decodeUniqueViolation(response).pipe(Effect.option)
    if (Option.isSome(duplicate)) return yield* Effect.fail(HelixDuplicate.make({}))
  }
  if (response.status >= 500)
    return yield* Effect.fail(
      ServiceUnavailable.make({ service: 'memory', message: 'HelixDB is unavailable' }),
    )
  if (response.status !== 200)
    return yield* Effect.fail(HelixRejected.make({ status: response.status }))
  return response
})

const isHelixConflict = Schema.is(HelixConflict)
/**
 * Helix commits optimistically: two writers at once can make one lose with HTTP 409
 * `transaction_conflict`, even when they touch different partitions (seen on plain inserts by
 * unrelated concurrent writers in the test runs of 4 Oct 2026).
 *
 * Sending a batch again is done ONLY where a second application converges whatever the first
 * attempt left behind: a receipted write (its receipt guards it), a creation under a unique id, a
 * tombstone, a guarded declaration, index DDL with `IfNotExists`, a brief overwritten with the same
 * payload. It is NOT done for `reinforce`, `link` or `supersede`: that a 409 always means nothing
 * became durable is measured for one conflicting receipt batch and read in Helix's source
 * (conflicts are rejected before apply), but is not established for every batch on the deployed
 * image, and a resent increment or edge would apply twice if it were false (review, 4 Oct 2026).
 *
 * The batch is sent again at once, with no wait: a clock-driven wait would stall under a controlled
 * test clock. A conflict that persists past this many attempts is returned as `HelixConflict`.
 */
const CONFLICT_RETRIES = 6

/** A convergent request: one attempt, sent again only after a transaction conflict. */
const resendHelix = Effect.fn('HelixMemory.resend')(function* (
  client: HttpClient.HttpClient,
  url: string,
  query: QueryRequest,
) {
  return yield* requestHelix(client, url, query).pipe(
    Effect.retry({ times: CONFLICT_RETRIES, while: isHelixConflict }),
  )
})

/**
 * Every index the adapter reads or relies on, named for failures. One embedding-dimension recipe
 * governs the vector index; labels materialize on first write. The receipt index is unique so two
 * attempts at one learning candidate cannot both commit.
 */
function requiredIndexes(dimensions: number) {
  return [
    { name: 'Memory.memoryId', spec: IndexSpec.nodeUniqueEquality('Memory', 'memoryId') },
    { name: 'Memory.tenant_id', spec: IndexSpec.nodeEquality('Memory', 'tenant_id') },
    { name: 'Memory.scope', spec: IndexSpec.nodeEquality('Memory', 'scope') },
    { name: 'Memory.isLatest', spec: IndexSpec.nodeEquality('Memory', 'isLatest') },
    { name: 'Memory.createdAt', spec: IndexSpec.nodeRangeDesc('Memory', 'createdAt') },
    { name: 'Memory.updatedAt', spec: IndexSpec.nodeRangeDesc('Memory', 'updatedAt') },
    {
      name: 'Memory.embedding',
      spec: IndexSpec.nodeVector(
        'Memory',
        'embedding',
        dimensions,
        VectorDistanceMetric.Cosine,
        'tenant_id',
      ),
    },
    { name: 'Memory.searchText', spec: IndexSpec.nodeText('Memory', 'searchText', 'tenant_id') },
    { name: 'MemoryBrief.briefId', spec: IndexSpec.nodeUniqueEquality('MemoryBrief', 'briefId') },
    { name: 'MemoryBrief.tenant_id', spec: IndexSpec.nodeEquality('MemoryBrief', 'tenant_id') },
    { name: 'MemoryBrief.personId', spec: IndexSpec.nodeEquality('MemoryBrief', 'personId') },
    {
      name: 'MemoryReceipt.receiptId',
      spec: IndexSpec.nodeUniqueEquality('MemoryReceipt', 'receiptId'),
    },
  ]
}

/** Parameterized F32 values preserve vector typing; content plus aliases share the BM25 document. */
const insertionParams = defineParams({
  partition: param.string(),
  id: param.string(),
  scope: param.string(),
  content: param.string(),
  searchText: param.string(),
  payload: param.string(),
  embedding: param.array(param.f32()),
  now: param.f64(),
})
function newRecord() {
  const p = insertionParams
  return g().addN('Memory', {
    tenant_id: p.partition,
    memoryId: p.id,
    scope: p.scope,
    content: p.content,
    searchText: p.searchText,
    payload: p.payload,
    embedding: p.embedding,
    isLatest: true,
    validTo: null,
    deletedAt: null,
    createdAt: p.now,
    updatedAt: p.now,
    accessCount: 1,
  })
}

/** Serialization happens once at persistence egress; aliases remain in the payload for future corrections. */
const insertionValues = Effect.fn('HelixMemory.insertionValues')(function* (input: {
  readonly partition: MemoryPartition
  readonly record: MemoryRecord
  readonly embedding: ReadonlyArray<number>
}) {
  const payload = yield* encodeRecord(input.record).pipe(
    Effect.mapError(() => HelixMalformed.make({})),
  )
  return {
    partition: input.partition,
    id: input.record.memory.id,
    scope: input.record.scope,
    content: input.record.memory.content,
    searchText: [input.record.memory.content, ...input.record.aliases].join(' '),
    payload,
    embedding: [...input.embedding],
    now: input.record.memory.createdAt,
  }
})

type InsertOnceInput = Parameters<HelixMemoryService['insertOnce']>[0]
type ReinforceOnceInput = Parameters<HelixMemoryService['reinforceOnce']>[0]
type SupersedeOnceInput = Parameters<HelixMemoryService['supersedeOnce']>[0]
const receiptProjection = [Projection.property('memoryId', 'memoryId')]
const ReceiptRow = Schema.Struct({ memoryId: MemoryId })
const decodeReceipt = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ receipts: Schema.Array(ReceiptRow) }),
)
const decodeReceiptedWrite = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ recorded: Schema.Array(ReceiptRow), applied: Schema.Array(ReceiptRow) }),
)

/** Receipts remain readable after forgetting or supersession; tenancy, not current(), qualifies them. */
function receiptNode(input: ReceiptIdentity) {
  return g()
    .nWithLabelWhere('MemoryReceipt', SourcePredicate.eq('receiptId', input.receiptId))
    .where(Predicate.eq('tenant_id', input.partition))
}

/**
 * Only an actual mutation earns a receipt. probe/guards.mjs reproduced a phantom receipt when
 * receipt absence alone guarded creation; skipped mutation variables must remain empty.
 */
function recordReceipt(
  batch: WriteBatch,
  mutation: string,
  input: ReceiptIdentity & {
    readonly record: MemoryRecord
  },
) {
  return batch
    .varAsIf(
      'receipt',
      BatchCondition.varNotEmpty(mutation),
      g().addN('MemoryReceipt', {
        receiptId: input.receiptId,
        tenant_id: input.partition,
        memoryId: input.record.memory.id,
        createdAt: input.record.memory.updatedAt,
      }),
    )
    .varAs('applied', g().n(NodeRef.var('receipt')).project(receiptProjection))
    .varAs('recorded', g().n(NodeRef.var('seen')).project(receiptProjection))
    .returning(['recorded', 'applied'])
}

/**
 * Chain eligibility through the target read: addE rejects an empty target, even with a valid
 * source (probe/ready.mjs). A replay or missing target therefore skips the edge entirely.
 */
function extendOnce(batch: WriteBatch, source: string, input: ReinforceOnceInput) {
  if (Option.isNone(input.extends) || input.extends.value === input.record.memory.id) return batch
  return batch
    .varAsIf(
      'extendsTarget',
      BatchCondition.varNotEmpty(source),
      identified({ partition: input.partition, id: input.extends.value }),
    )
    .varAsIf(
      'extended',
      BatchCondition.varNotEmpty('extendsTarget'),
      g().n(NodeRef.var(source)).addE('EXTENDS', NodeRef.var('extendsTarget'), {
        tenant_id: input.partition,
      }),
    )
}

/** Receipt absence controls creation; its resulting variable controls every dependent mutation. */
function insertingOnce(input: InsertOnceInput) {
  const batch = writeBatch()
    .varAs('seen', receiptNode(input))
    .varAsIf('created', BatchCondition.varEmpty('seen'), newRecord())
  return recordReceipt(extendOnce(batch, 'created', input), 'created', input)
}

/** A vanished current target cannot increment accessCount, add context, or consume the candidate. */
function reinforcingOnce(input: ReinforceOnceInput, payload: string) {
  const batch = writeBatch()
    .varAs('seen', receiptNode(input))
    .varAsIf(
      'target',
      BatchCondition.varEmpty('seen'),
      identified({ partition: input.partition, id: input.record.memory.id }),
    )
    .varAsIf(
      'reinforced',
      BatchCondition.varNotEmpty('target'),
      g()
        .n(NodeRef.var('target'))
        .setProperty('payload', payload)
        .setProperty('searchText', [input.record.memory.content, ...input.record.aliases].join(' '))
        .setProperty('updatedAt', input.record.memory.updatedAt)
        .setProperty('accessCount', Expr.prop('accessCount').add(Expr.val(1))),
    )
  return recordReceipt(extendOnce(batch, 'reinforced', input), 'reinforced', input)
}

/**
 * Both neighbour reads depend on creation, while each copied edge keeps its nonempty-neighbour
 * guard. probe/guards.mjs proves replay can otherwise link a populated source to skipped created.
 */
function copyLinksOnce(batch: WriteBatch, partition: MemoryPartition, kind: MemoryLinkKind) {
  const eligible = Predicate.and([Predicate.eq('tenant_id', partition), current()])
  return batch
    .varAsIf(
      `${kind}out`,
      BatchCondition.varNotEmpty('created'),
      g().n(NodeRef.var('old')).out(kind).where(eligible),
    )
    .varAsIf(
      `${kind}in`,
      BatchCondition.varNotEmpty('created'),
      g().n(NodeRef.var('old')).in(kind).where(eligible),
    )
    .varAsIf(
      `${kind}forward`,
      BatchCondition.varNotEmpty(`${kind}out`),
      g()
        .n(NodeRef.var('created'))
        .addE(kind, NodeRef.var(`${kind}out`), { tenant_id: partition }),
    )
    .varAsIf(
      `${kind}reverse`,
      BatchCondition.varNotEmpty(`${kind}in`),
      g()
        .n(NodeRef.var(`${kind}in`))
        .addE(kind, NodeRef.var('created'), { tenant_id: partition }),
    )
}

/** Replacement, both copied directions, invalidation and receipt share the old-record precondition. */
function supersedingOnce(input: SupersedeOnceInput) {
  const batch = writeBatch()
    .varAs('seen', receiptNode(input))
    .varAsIf(
      'old',
      BatchCondition.varEmpty('seen'),
      identified({
        partition: input.partition,
        id: input.oldId,
      }),
    )
    .varAsIf('created', BatchCondition.varNotEmpty('old'), newRecord())
    .varAsIf(
      'link',
      BatchCondition.varNotEmpty('created'),
      g().n(NodeRef.var('created')).addE('UPDATES', NodeRef.var('old'), {
        tenant_id: input.partition,
      }),
    )
  const linked = MemoryLinkKind.literals.reduce(
    (result, kind) => copyLinksOnce(result, input.partition, kind),
    batch,
  )
  const invalidated = linked.varAsIf(
    'invalidated',
    BatchCondition.varNotEmpty('created'),
    g()
      .n(NodeRef.var('old'))
      .setProperty('isLatest', false)
      .setProperty('validTo', input.record.memory.createdAt)
      .setProperty('updatedAt', input.record.memory.updatedAt),
  )
  return recordReceipt(invalidated, 'created', input)
}

/** Decode only committed projections; absence is meaningful only for operations targeting a record. */
const receiptedOutcome = Effect.fn('HelixMemory.receiptedOutcome')(function* (
  session: HelixSession,
  query: QueryRequest,
) {
  const response = yield* session.resend(query)
  const rows = yield* decodeReceiptedWrite(response).pipe(
    Effect.mapError(() => HelixMalformed.make({})),
  )
  if (rows.applied.length > 0) return ReceiptedWrite.cases.Applied.make({})
  const seen = rows.recorded[0]
  if (seen !== undefined) return ReceiptedWrite.cases.Recorded.make({ memoryId: seen.memoryId })
  return ReceiptedWrite.cases.Missing.make({})
})

/** Public receipt methods retain one request per read/write and leave model-tool mutations unchanged. */
function receipted(session: HelixSession) {
  return {
    /** A historical receipt is independent of the recorded memory's present lifecycle. */
    receipt: Effect.fn('HelixMemory.receipt')(function* (input: ReceiptIdentity) {
      const response = yield* session.request(
        readBatch()
          .varAs('receipts', receiptNode(input).project(receiptProjection))
          .returning(['receipts'])
          .toQueryRequest(),
      )
      const rows = yield* decodeReceipt(response).pipe(
        Effect.mapError(() => HelixMalformed.make({})),
      )
      return Option.map(Option.fromUndefinedOr(rows.receipts[0]), (row) => row.memoryId)
    }),
    /** Insert has no missing-target branch; empty committed projections expose an adapter invariant failure. */
    insertOnce: Effect.fn('HelixMemory.insertOnce')(function* (input: InsertOnceInput) {
      const values = yield* insertionValues(input)
      const result = yield* receiptedOutcome(
        session,
        insertingOnce(input).toQueryRequest(insertionParams, values),
      )
      if (ReceiptedWrite.guards.Missing(result)) return yield* Effect.fail(HelixMalformed.make({}))
      return result
    }),
    /** Reinforcement persists the first application's aliases and timestamp; a replay does not rewrite them. */
    reinforceOnce: Effect.fn('HelixMemory.reinforceOnce')(function* (input: ReinforceOnceInput) {
      const payload = yield* encodeRecord(input.record).pipe(
        Effect.mapError(() => HelixMalformed.make({})),
      )
      return yield* receiptedOutcome(session, reinforcingOnce(input, payload).toQueryRequest())
    }),
    /** Only a current old version can earn the atomic replacement and its receipt. */
    supersedeOnce: Effect.fn('HelixMemory.supersedeOnce')(function* (input: SupersedeOnceInput) {
      const values = yield* insertionValues(input)
      return yield* receiptedOutcome(
        session,
        supersedingOnce(input).toQueryRequest(insertionParams, values),
      )
    }),
  }
}

/** Brief identity includes the partition so the same Person has independent pages in different spaces. */
function briefNode(input: BriefIdentity) {
  return g()
    .nWithLabelWhere(
      'MemoryBrief',
      SourcePredicate.eq('briefId', JSON.stringify([input.partition, input.personId])),
    )
    .where(Predicate.eq('tenant_id', input.partition))
}
const BriefRow = Schema.Struct({
  briefs: Schema.Array(Schema.Struct({ brief: Schema.fromJsonString(MemoryBrief) })),
  changes: Schema.NullOr(Schema.Array(Schema.Struct({ updatedAt: Schema.Number }))),
})
const encodeBrief = Schema.encodeEffect(Schema.fromJsonString(MemoryBrief))
const decodeRows = HttpClientResponse.schemaBodyJson(Rows)
const decodeSearch = HttpClientResponse.schemaBodyJson(SearchRows)
const decodeBrief = HttpClientResponse.schemaBodyJson(BriefRow)
const decodeCreation = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ receipt: Schema.Array(Schema.Struct({ id: MemoryId })) }),
)

interface HelixSession {
  /**
   * One attempt, made only once the indexes are known to be active. Operations never hold the raw
   * client or address, so none of them can reach Helix around the readiness.
   */
  readonly request: (
    query: QueryRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HelixFailure>
  /** The same, sent again after a transaction conflict; only for a write whose second application converges. */
  readonly resend: (
    query: QueryRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HelixFailure>
  readonly records: (
    query: QueryRequest,
  ) => Effect.Effect<ReadonlyArray<MemoryRecord>, HelixFailure>
  readonly write: (query: QueryRequest) => Effect.Effect<void, HelixFailure>
  /** A write whose second application converges, so it is sent again after a transaction conflict. */
  readonly rewrite: (query: QueryRequest) => Effect.Effect<void, HelixFailure>
}

/** Reads share one decoded session and constrain candidates before ranking or traversing. */
function readers(session: HelixSession) {
  const { request, records } = session
  return {
    /** Enumerate only scope metadata; the policy authorizes Threads before reading their content. */
    scopes: Effect.fn('HelixMemory.scopes')(function* (partition: MemoryPartition) {
      const query = readBatch()
        .varAs(
          'scopes',
          g()
            .nWithLabelWhere('Memory', SourcePredicate.eq('tenant_id', partition))
            .where(current())
            .project([Projection.property('scope', 'scope')]),
        )
        .returning(['scopes'])
        .toQueryRequest()
      const response = yield* request(query)
      const rows = yield* decodeScopes(response).pipe(
        Effect.mapError(() => HelixMalformed.make({})),
      )
      return [...new Set(rows.scopes.map((row) => row.scope))]
    }),
    /** Exact latest lookup stays partition-qualified; absence is a value, never a fabricated record. */
    get: Effect.fn('HelixMemory.get')(function* (input: RecordIdentity) {
      return Option.fromUndefinedOr(
        (yield* records(
          readBatch()
            .varAs('records', identified(input).project(projection))
            .returning(['records'])
            .toQueryRequest(),
        ))[0],
      )
    }),
    /** Return at most the 200 newest current readable records; the bound applies after scope filtering. */
    list: Effect.fn('HelixMemory.list')(function* (input: ReadScope) {
      return yield* records(
        readBatch()
          .varAs(
            'records',
            visible(input).orderBy('createdAt', Order.Desc).limit(200).project(projection),
          )
          .returning(['records'])
          .toQueryRequest(),
      )
    }),
    /** Both modalities rank the identical live, readable set and receive the tenant at index lookup. */
    search: Effect.fn('HelixMemory.search')(function* (input: SearchInput) {
      const p = searchParams
      const candidates = visible(input)
      const query = readBatch()
        .varAs(
          'vector',
          candidates
            .vectorSearchWith('Memory', 'embedding', p.embedding, p.limit, p.partition)
            .project([...projection, Projection.property('$distance', 'distance')]),
        )
        .varAs(
          'keyword',
          candidates
            .textSearchWith('Memory', 'searchText', p.query, p.limit, p.partition)
            .project(projection),
        )
        .returning(['vector', 'keyword'])
        .toQueryRequest(searchParams, {
          partition: input.partition,
          scopes: [...input.scopes],
          query: input.query,
          embedding: [...input.embedding],
          limit: BigInt(input.limit),
        })
      const response = yield* request(query)
      return yield* decodeSearch(response).pipe(Effect.mapError(() => HelixMalformed.make({})))
    }),
    /** One graph hop rechecks edge tenancy and neighbor scope before limiting context. */
    expand: Effect.fn('HelixMemory.expand')(function* (
      input: ReadScope & { readonly ids: ReadonlyArray<MemoryId>; readonly limit: number },
    ) {
      const seeds = visible(input).where(Predicate.isIn('memoryId', [...input.ids]))
      const neighbors = seeds
        .bothE()
        .where(
          Predicate.and([
            Predicate.eq('tenant_id', input.partition),
            Predicate.isIn('$label', ['RELATES_TO', 'EXTENDS']),
          ]),
        )
        .otherN()
        .where(
          Predicate.and([
            Predicate.eq('tenant_id', input.partition),
            Predicate.isIn('scope', [...input.scopes]),
            current(),
          ]),
        )
        .dedup()
        .limit(input.limit)
      return yield* records(
        readBatch()
          .varAs('records', neighbors.project(projection))
          .returning(['records'])
          .toQueryRequest(),
      )
    }),
  }
}

/** Rebuild lazily only when an explicitly readable scope changed after the page, including superseded or deleted records. No other Person page is deleted. */
function readingBrief(session: HelixSession) {
  const { request } = session
  return Effect.fn('HelixMemory.briefGet')(function* (input: BriefIdentity & ReadScope) {
    const response = yield* request(
      readBatch()
        .varAs('briefs', briefNode(input).project([Projection.property('payload', 'brief')]))
        .varAs(
          'changes',
          g()
            .nWithLabelWhere('Memory', SourcePredicate.eq('tenant_id', input.partition))
            .where(Predicate.isIn('scope', [...input.scopes]))
            .orderBy('updatedAt', Order.Desc)
            .limit(1)
            .project([Projection.property('updatedAt', 'updatedAt')]),
        )
        .returning(['briefs', 'changes'])
        .toQueryRequest(),
    )
    const decoded = yield* decodeBrief(response).pipe(
      Effect.mapError(() => HelixMalformed.make({})),
    )
    const row = decoded.briefs[0]
    if (row === undefined) return Option.none<MemoryBrief>()
    const latest = decoded.changes === null ? undefined : decoded.changes[0]
    if (
      latest !== undefined &&
      (row.brief.updatedAt === null || latest.updatedAt > row.brief.updatedAt)
    )
      return Option.none<MemoryBrief>()
    return Option.some(row.brief)
  })
}

/** Writes use one batch for each lifecycle transition so a replacement cannot expose two latest records. */
function writers(session: HelixSession) {
  const { write, rewrite } = session
  return {
    /** Creation writes searchable fields and attribution together; scoped timestamps invalidate readable pages lazily. */
    insert: Effect.fn('HelixMemory.insert')(function* (input: {
      readonly partition: MemoryPartition
      readonly record: MemoryRecord
      readonly embedding: ReadonlyArray<number>
    }) {
      const values = yield* insertionValues(input)
      yield* rewrite(
        writeBatch()
          .varAs('created', newRecord())
          .returning([])
          .toQueryRequest(insertionParams, values),
      )
    }),
    /** Reinforcement preserves identity and content while persisting its timestamp in both projection and payload. */
    reinforce: Effect.fn('HelixMemory.reinforce')(function* (input: {
      readonly partition: MemoryPartition
      readonly record: MemoryRecord
    }) {
      const payload = yield* encodeRecord(input.record).pipe(
        Effect.mapError(() => HelixMalformed.make({})),
      )
      yield* write(
        writeBatch()
          .varAs(
            'reinforced',
            identified({ partition: input.partition, id: input.record.memory.id })
              .setProperty('payload', payload)
              .setProperty(
                'searchText',
                [input.record.memory.content, ...input.record.aliases].join(' '),
              )
              .setProperty('updatedAt', input.record.memory.updatedAt)
              .setProperty('accessCount', Expr.prop('accessCount').add(Expr.val(1))),
          )
          .returning([])
          .toQueryRequest(),
      )
    }),
    /** Soft deletion removes records from every live predicate and invalidates previously derived briefs. */
    forget: Effect.fn('HelixMemory.forget')(function* (
      input: RecordIdentity & { readonly now: number },
    ) {
      yield* rewrite(
        writeBatch()
          .varAs(
            'forgotten',
            identified(input)
              .setProperty('deletedAt', input.now)
              .setProperty('updatedAt', input.now),
          )
          .returning([])
          .toQueryRequest(),
      )
    }),
    /** The unique partition/Person page is created or replaced without touching another workspace. */
    briefPut: Effect.fn('HelixMemory.briefPut')(function* (
      input: BriefIdentity & { readonly brief: MemoryBrief },
    ) {
      const payload = yield* encodeBrief(input.brief).pipe(
        Effect.mapError(() => HelixMalformed.make({})),
      )
      yield* rewrite(
        writeBatch()
          .varAs('existing', briefNode(input))
          .varAsIf(
            'updated',
            BatchCondition.varNotEmpty('existing'),
            g().n(NodeRef.var('existing')).setProperty('payload', payload),
          )
          .varAsIf(
            'created',
            BatchCondition.varEmpty('existing'),
            g().addN('MemoryBrief', {
              tenant_id: input.partition,
              personId: input.personId,
              briefId: JSON.stringify([input.partition, input.personId]),
              payload,
            }),
          )
          .returning([])
          .toQueryRequest(),
      )
    }),
  }
}

/** Creation, UPDATES edge, and old-version invalidation commit in one write request. */
function superseding(session: HelixSession) {
  const { request } = session
  return Effect.fn('HelixMemory.supersede')(function* (input: {
    readonly partition: MemoryPartition
    readonly oldId: MemoryId
    readonly record: MemoryRecord
    readonly embedding: ReadonlyArray<number>
  }) {
    const values = yield* insertionValues(input)
    const batch = writeBatch()
      .varAs('old', identified({ partition: input.partition, id: input.oldId }))
      .varAsIf('created', BatchCondition.varNotEmpty('old'), newRecord())
      .varAs(
        'link',
        g()
          .n(NodeRef.var('created'))
          .addE('UPDATES', NodeRef.var('old'), { tenant_id: input.partition }),
      )
    // Helix addE rejects an empty target variable; each directed label is guarded independently.
    const linked = MemoryLinkKind.literals.reduce(
      (linkedBatch, kind) =>
        linkedBatch
          .varAs(
            `${kind}out`,
            g()
              .n(NodeRef.var('old'))
              .out(kind)
              .where(Predicate.and([Predicate.eq('tenant_id', input.partition), current()])),
          )
          .varAs(
            `${kind}in`,
            g()
              .n(NodeRef.var('old'))
              .in(kind)
              .where(Predicate.and([Predicate.eq('tenant_id', input.partition), current()])),
          )
          .varAsIf(
            `${kind}forward`,
            BatchCondition.varNotEmpty(`${kind}out`),
            g()
              .n(NodeRef.var('created'))
              .addE(kind, NodeRef.var(`${kind}out`), { tenant_id: input.partition }),
          )
          .varAsIf(
            `${kind}reverse`,
            BatchCondition.varNotEmpty(`${kind}in`),
            g()
              .n(NodeRef.var(`${kind}in`))
              .addE(kind, NodeRef.var('created'), { tenant_id: input.partition }),
          ),
      batch,
    )
    const query = linked
      .varAs(
        'invalidated',
        g()
          .n(NodeRef.var('old'))
          .setProperty('isLatest', false)
          .setProperty('validTo', input.record.memory.createdAt)
          .setProperty('updatedAt', input.record.memory.updatedAt),
      )
      .varAs(
        'receipt',
        g()
          .n(NodeRef.var('created'))
          .project([Projection.property('memoryId', 'id')]),
      )
      .returning(['receipt'])
      .toQueryRequest(insertionParams, values)
    const response = yield* request(query)
    const created = yield* decodeCreation(response).pipe(
      Effect.mapError(() => HelixMalformed.make({})),
    )
    if (created.receipt.length === 0) yield* Effect.fail(HelixConflict.make({}))
  })
}

/** Links are written only between latest records of one partition; recall independently filters both endpoints. */
function linking(session: HelixSession) {
  return Effect.fn('HelixMemory.link')(function* (input: MemoryLink) {
    yield* session.write(
      writeBatch()
        .varAs('from', identified({ partition: input.partition, id: input.from }))
        .varAs('to', identified({ partition: input.partition, id: input.to }))
        .varAs(
          'linked',
          g()
            .n(NodeRef.var('from'))
            .addE(input.kind, NodeRef.var('to'), { tenant_id: input.partition }),
        )
        .returning([])
        .toQueryRequest(),
    )
  })
}

const IndexConfiguration = Schema.Struct({
  configurations: Schema.Array(Schema.Struct({ model: Schema.String, dimensions: Schema.Int })),
})
const decodeIndex = HttpClientResponse.schemaBodyJson(IndexConfiguration)

/** Fail before opening an existing index under a different embedding space, even when dimensions happen to match. */
const checkIndex = Effect.fn('HelixMemory.checkIndex')(function* (
  session: { readonly client: HttpClient.HttpClient; readonly url: string },
  expected: { readonly model: string; readonly dimensions: number },
) {
  const response = yield* requestHelix(
    session.client,
    session.url,
    readBatch()
      .varAs(
        'configurations',
        g()
          .nWithLabelWhere('MemoryIndex', SourcePredicate.eq('indexId', 'content'))
          .project([
            Projection.property('model', 'model'),
            Projection.property('dimensions', 'dimensions'),
          ]),
      )
      .returning(['configurations'])
      .toQueryRequest(),
  )
  const decoded = yield* decodeIndex(response).pipe(Effect.mapError(() => HelixMalformed.make({})))
  for (const actual of decoded.configurations) {
    if (actual.model !== expected.model || actual.dimensions !== expected.dimensions)
      yield* Effect.fail(
        MemoryIndexMismatch.make({
          expectedModel: expected.model,
          actualModel: actual.model,
          expectedDimensions: expected.dimensions,
          actualDimensions: actual.dimensions,
        }),
      )
  }
})

/** Capture the embedding space once, after indexes exist, without overwriting an existing declaration. */
function declareIndex(model: string, dimensions: number) {
  return writeBatch()
    .varAs('existing', g().nWithLabelWhere('MemoryIndex', SourcePredicate.eq('indexId', 'content')))
    .varAsIf(
      'created',
      BatchCondition.varEmpty('existing'),
      g().addN('MemoryIndex', { indexId: 'content', model, dimensions }),
    )
    .returning([])
    .toQueryRequest()
}

const IndexDdl = Schema.Union([
  Schema.Struct({ kind: Schema.tag('accepted'), operation_id: Schema.String }),
  Schema.Struct({ kind: Schema.tag('existing_operation'), operation_id: Schema.String }),
  Schema.Struct({ kind: Schema.tag('already_active') }),
]).pipe(Schema.toTaggedUnion('kind'))
const decodeIndexDdl = HttpClientResponse.schemaBodyJson(Schema.Struct({ index: IndexDdl }))
const IndexStatus = Schema.Union([
  Schema.Struct({ status: Schema.tag('queued') }),
  Schema.Struct({ status: Schema.tag('running') }),
  Schema.Struct({ status: Schema.tag('succeeded') }),
  Schema.Struct({ status: Schema.tag('blocked') }),
  Schema.Struct({ status: Schema.tag('aborted') }),
]).pipe(Schema.toTaggedUnion('status'))
const decodeIndexStatus = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ operation: IndexStatus }),
)
/**
 * A pending build is asked again every 100 ms for at most 30 seconds per index. A build on empty
 * storage finishes within a few such waits; thirteen indexes at one-second waits made a first
 * acquisition take longer than a request should wait.
 */
const indexSchedule = Schedule.spaced('100 millis').pipe(Schedule.upTo({ duration: '30 seconds' }))
/** The longest one acquisition waits for its indexes, stalled answers included. */
const INDEX_DEADLINE: Duration.Input = '45 seconds'
const isIndexUnready = Schema.is(IndexUnready)

interface RequiredIndex {
  readonly name: string
  readonly spec: IndexSpec
}

/** SDK 3.0.4 answers DDL before enforcement; only a succeeded build operation makes the index usable. */
const indexStatus = Effect.fn('HelixMemory.indexStatus')(function* (
  session: { readonly client: HttpClient.HttpClient; readonly url: string },
  input: { readonly index: string; readonly operationId: string },
) {
  const response = yield* requestHelix(
    session.client,
    session.url,
    readBatch()
      .varAs('operation', g().getIndexOperation(input.operationId))
      .returning(['operation'])
      .toQueryRequest(),
  )
  const decoded = yield* decodeIndexStatus(response).pipe(
    Effect.mapError(() => HelixMalformed.make({})),
  )
  const unready = (state: 'pending' | 'blocked' | 'aborted') =>
    Effect.fail(IndexUnready.make({ index: input.index, state }))
  return yield* IndexStatus.match(decoded.operation, {
    succeeded: () => Effect.void,
    blocked: () => unready('blocked'),
    aborted: () => unready('aborted'),
    queued: () => unready('pending'),
    running: () => unready('pending'),
  })
})

interface StartedIndex {
  readonly name: string
  /** The build still to wait for; none when the index was already active. */
  readonly operation: Option.Option<string>
}

/** Declare one index. Helix answers at once: already active, or a build operation to wait for. */
const startIndex = Effect.fn('HelixMemory.startIndex')(function* (
  session: { readonly client: HttpClient.HttpClient; readonly url: string },
  index: RequiredIndex,
) {
  const response = yield* resendHelix(
    session.client,
    session.url,
    writeBatch()
      .varAs('index', g().createIndexIfNotExists(index.spec))
      .returning(['index'])
      .toQueryRequest(),
  )
  const decoded = yield* decodeIndexDdl(response).pipe(
    Effect.mapError(() => HelixMalformed.make({})),
  )
  return IndexDdl.match(decoded.index, {
    already_active: (): StartedIndex => ({ name: index.name, operation: Option.none() }),
    accepted: ({ operation_id }) => ({ name: index.name, operation: Option.some(operation_id) }),
    existing_operation: ({ operation_id }) => ({
      name: index.name,
      operation: Option.some(operation_id),
    }),
  })
})

/** Wait until a started build has succeeded; blocked, aborted or still pending at the bound fails. */
const awaitIndex = Effect.fn('HelixMemory.awaitIndex')(function* (
  session: { readonly client: HttpClient.HttpClient; readonly url: string },
  started: StartedIndex,
) {
  if (Option.isNone(started.operation)) return
  yield* indexStatus(session, { index: started.name, operationId: started.operation.value }).pipe(
    Effect.retry({
      schedule: indexSchedule,
      while: (error) => isIndexUnready(error) && error.state === 'pending',
    }),
  )
})

/** Start every build, then wait for all of them side by side. */
const buildIndexes = Effect.fn('HelixMemory.buildIndexes')(function* (
  session: { readonly client: HttpClient.HttpClient; readonly url: string },
  indexes: ReadonlyArray<RequiredIndex>,
) {
  const started = yield* Effect.forEach(indexes, (index) => startIndex(session, index))
  yield* Effect.forEach(started, (index) => awaitIndex(session, index), {
    concurrency: 'unbounded',
    discard: true,
  })
})

/**
 * Declare the given indexes and wait until all are active. The service is not offered before every
 * required index is: a search against a pending vector or text index fails `index_not_found`, a
 * pending unique index admits duplicates, and writes arriving while a build runs kept a text build
 * from finishing in the test runs of 4 Oct 2026. All builds are started before any is waited for,
 * so Helix runs them side by side; waiting for them one after another made a first acquisition on
 * empty storage take many seconds. A failed build fails acquisition with the index named; the build
 * continues in Helix and a later acquisition joins it.
 */
const readyIndexes = Effect.fn('HelixMemory.readyIndexes')(function* (
  session: { readonly client: HttpClient.HttpClient; readonly url: string },
  indexes: ReadonlyArray<RequiredIndex>,
) {
  // The schedule bounds how often a build is asked about, not how long one answer may take: the
  // HTTP client waits up to an hour for headers. This deadline bounds the whole acquisition.
  return yield* buildIndexes(session, indexes).pipe(
    Effect.timeoutOrElse({
      duration: INDEX_DEADLINE,
      orElse: () =>
        Effect.fail(
          IndexUnready.make({
            index: indexes.map((index) => index.name).join(', '),
            state: 'pending',
          }),
        ),
    }),
  )
})

/**
 * Declare every index, check the stored embedding space and record it. Nothing here is specific to
 * one call, and all of it converges when run again (`IfNotExists`, a guarded declaration), so it
 * is safe to repeat until it has succeeded once.
 */
const bootstrap = Effect.fn('HelixMemory.bootstrap')(function* (
  session: { readonly client: HttpClient.HttpClient; readonly url: string },
  expected: { readonly model: string; readonly dimensions: number },
) {
  // The declaration index first: `checkIndex` reads through it before anything else is built.
  yield* readyIndexes(session, [
    {
      name: 'MemoryIndex.indexId',
      spec: IndexSpec.nodeUniqueEquality('MemoryIndex', 'indexId'),
    },
  ])
  yield* checkIndex(session, expected)
  yield* readyIndexes(session, requiredIndexes(expected.dimensions))
  yield* resendHelix(session.client, session.url, declareIndex(expected.model, expected.dimensions))
  yield* checkIndex(session, expected)
})

const isIndexMismatch = Schema.is(MemoryIndexMismatch)

/** An absolute `http:` or `https:` address; request paths are appended to it as text. */
const helixAddress = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (URL.canParse(value) && /^https?:$/u.test(new URL(value).protocol)) ||
      'an absolute http or https address',
  ),
)

/**
 * No SDK Promise or raw fetch crosses this boundary.
 *
 * Memory is part of every Vivid, so `VIVID_HELIX_URL` is required while the server is composed and
 * its absence stops launch naming it. There is no server that runs "without memory".
 *
 * Helix itself not answering, or an index still building, is a different thing: an infrastructure
 * failure, which can begin and end while the server runs. It is never a state the Layer settles
 * into. The bootstrap is a readiness every operation waits for: it runs until it has succeeded
 * once and is then remembered for the life of the process, while a failed attempt is forgotten at
 * once, so the next call tries again and memory is back as soon as Helix answers, with no restart.
 * Callers that arrive while an attempt is running share it rather than starting their own
 * (`Effect.cachedWithTTL` with a time to live taken from the `Exit`, effect `Effect.ts`).
 *
 * Before this, a failed bootstrap at start either stopped the whole server (Helix unreachable) or
 * switched memory off until the next restart (an index not yet active).
 *
 * The first attempt is made here, so a healthy start serves its first call warm. Its failure
 * stops launch only when it is a setting that is wrong: stored vectors made by another embedding
 * model or size (`MemoryIndexMismatch`) cannot be fixed by waiting. Any other failure is logged
 * and left to the next call.
 */
export const helixMemoryLayer = Layer.effect(
  HelixMemory,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    // Checked to be an address a request can be sent to. A word that is not one (`helix`) would
    // pass as text, fail every bootstrap as "unreachable", and leave a server that runs for its
    // whole life with memory that can never answer: the quiet state this Layer exists to rule out.
    const url = (yield* requiredSetting(
      'VIVID_HELIX_URL',
      helixAddress,
      'the absolute http or https address of the Helix memory service',
    )).replace(/\/+$/u, '')
    const dimensions = yield* embeddingDimensions
    const model = yield* embeddingModel
    const ready = yield* Effect.cachedWithTTL(
      bootstrap({ client, url }, { model, dimensions }),
      (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    )
    yield* ready.pipe(
      Effect.catchIf(
        (failure) => !isIndexMismatch(failure),
        (failure) =>
          Effect.logWarning('Memory is not answering yet; the next memory call tries again', {
            tag: failure._tag,
          }),
      ),
    )
    /** Every operation's request waits for readiness first; a failed readiness fails that call, typed. */
    const request = Effect.fn('HelixMemory.send')(function* (query: QueryRequest) {
      yield* ready
      return yield* requestHelix(client, url, query)
    })
    const resend = Effect.fn('HelixMemory.sendAgain')(function* (query: QueryRequest) {
      yield* ready
      return yield* resendHelix(client, url, query)
    })
    /** Typed projection decoding is shared by list, exact lookups, and bounded graph expansion. */
    const records = Effect.fn('HelixMemory.records')(function* (query: QueryRequest) {
      const response = yield* request(query)
      const decoded = yield* decodeRows(response).pipe(
        Effect.mapError(() => HelixMalformed.make({})),
      )
      return decoded.records.map((row) => row.record)
    })
    /** Mutation results are deliberately void; authoritative state is read through typed projections. */
    const write = Effect.fn('HelixMemory.write')(function* (query: QueryRequest) {
      yield* request(query)
    })
    const rewrite = Effect.fn('HelixMemory.rewrite')(function* (query: QueryRequest) {
      yield* resend(query)
    })
    const session: HelixSession = { request, resend, records, write, rewrite }
    return HelixMemory.of({
      ...readers(session),
      ...writers(session),
      ...receipted(session),
      link: linking(session),
      briefGet: readingBrief(session),
      supersede: superseding(session),
    })
  }),
)
