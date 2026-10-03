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
} from '@helix-db/helix-db'
import { Memory, MemoryBrief, MemoryId, PersonId, ServiceUnavailable } from '@vivid/contracts'
import { Config, Context, Effect, Layer, Option, Schema } from 'effect'
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
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

/** The published SDK supplies the AST; Effect HttpClient owns transport and response validation. */
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
  if (response.status >= 500)
    return yield* Effect.fail(
      ServiceUnavailable.make({ service: 'memory', message: 'HelixDB is unavailable' }),
    )
  if (response.status !== 200)
    return yield* Effect.fail(HelixRejected.make({ status: response.status }))
  return response
})

/** Idempotent index creation uses the single embedding-dimension recipe; labels materialize on first write. */
function bootstrap(dimensions: number) {
  const specs = [
    IndexSpec.nodeUniqueEquality('MemoryIndex', 'indexId'),
    IndexSpec.nodeUniqueEquality('Memory', 'memoryId'),
    IndexSpec.nodeEquality('Memory', 'tenant_id'),
    IndexSpec.nodeEquality('Memory', 'scope'),
    IndexSpec.nodeEquality('Memory', 'isLatest'),
    IndexSpec.nodeRangeDesc('Memory', 'createdAt'),
    IndexSpec.nodeRangeDesc('Memory', 'updatedAt'),
    IndexSpec.nodeVector(
      'Memory',
      'embedding',
      dimensions,
      VectorDistanceMetric.Cosine,
      'tenant_id',
    ),
    IndexSpec.nodeText('Memory', 'searchText', 'tenant_id'),
    IndexSpec.nodeUniqueEquality('MemoryBrief', 'briefId'),
    IndexSpec.nodeEquality('MemoryBrief', 'tenant_id'),
    IndexSpec.nodeEquality('MemoryBrief', 'personId'),
  ]
  const batch = specs.reduce(
    (result, spec, index) => result.varAs(`index${index}`, g().createIndexIfNotExists(spec)),
    writeBatch(),
  )
  return batch.returning([]).toQueryRequest()
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
  readonly client: HttpClient.HttpClient
  readonly url: string
  readonly records: (
    query: QueryRequest,
  ) => Effect.Effect<ReadonlyArray<MemoryRecord>, HelixFailure>
  readonly write: (query: QueryRequest) => Effect.Effect<void, HelixFailure>
}

/** Reads share one decoded session and constrain candidates before ranking or traversing. */
function readers(session: HelixSession) {
  const { client, url, records } = session
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
      const response = yield* requestHelix(client, url, query)
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
      const response = yield* requestHelix(client, url, query)
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
  const { client, url } = session
  return Effect.fn('HelixMemory.briefGet')(function* (input: BriefIdentity & ReadScope) {
    const response = yield* requestHelix(
      client,
      url,
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
  const { write } = session
  return {
    /** Creation writes searchable fields and attribution together; scoped timestamps invalidate readable pages lazily. */
    insert: Effect.fn('HelixMemory.insert')(function* (input: {
      readonly partition: MemoryPartition
      readonly record: MemoryRecord
      readonly embedding: ReadonlyArray<number>
    }) {
      const values = yield* insertionValues(input)
      yield* write(
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
      yield* write(
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
      yield* write(
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
  const { client, url } = session
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
    const response = yield* requestHelix(client, url, query)
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

/** Acquisition bootstraps indexes before accepting writes. No SDK Promise or raw fetch crosses this boundary. */
export const helixMemoryLayer = Layer.effect(
  HelixMemory,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const url = yield* Config.String('VIVID_HELIX_URL').pipe(
      Effect.mapError(() =>
        ServiceUnavailable.make({ service: 'memory', message: 'VIVID_HELIX_URL is unconfigured' }),
      ),
    )
    const dimensions = yield* embeddingDimensions.pipe(
      Effect.mapError(() =>
        ServiceUnavailable.make({
          service: 'memory',
          message: 'VIVID_EMBEDDING_DIMENSIONS is invalid',
        }),
      ),
    )
    const model = yield* embeddingModel.pipe(
      Effect.mapError(() =>
        ServiceUnavailable.make({ service: 'memory', message: 'VIVID_EMBEDDING_MODEL is invalid' }),
      ),
    )
    yield* requestHelix(
      client,
      url,
      writeBatch()
        .varAs(
          'index',
          g().createIndexIfNotExists(IndexSpec.nodeUniqueEquality('MemoryIndex', 'indexId')),
        )
        .returning([])
        .toQueryRequest(),
    )
    yield* checkIndex({ client, url }, { model, dimensions })
    yield* requestHelix(client, url, bootstrap(dimensions))
    yield* requestHelix(client, url, declareIndex(model, dimensions))
    yield* checkIndex({ client, url }, { model, dimensions })
    /** Typed projection decoding is shared by list, exact lookups, and bounded graph expansion. */
    const records = Effect.fn('HelixMemory.records')(function* (query: QueryRequest) {
      const response = yield* requestHelix(client, url, query)
      const decoded = yield* decodeRows(response).pipe(
        Effect.mapError(() => HelixMalformed.make({})),
      )
      return decoded.records.map((row) => row.record)
    })
    /** Mutation results are deliberately void; authoritative state is read through typed projections. */
    const write = Effect.fn('HelixMemory.write')(function* (query: QueryRequest) {
      yield* requestHelix(client, url, query)
    })
    return HelixMemory.of({
      ...readers({ client, url, records, write }),
      ...writers({ client, url, records, write }),
      link: linking({ client, url, records, write }),
      briefGet: readingBrief({ client, url, records, write }),
      supersede: superseding({ client, url, records, write }),
    })
  }),
)
