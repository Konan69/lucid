import * as NodeCrypto from 'node:crypto'
import { g, Order, Predicate, Projection, readBatch, SourcePredicate } from '@helix-db/helix-db'
import { Effect, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import {
  MemoryEntry,
  MemoryKind,
  PersonId,
  ThreadId,
  type RuntimeHistoryBody,
} from '@vivid/contracts'

/** This reader never logs a URL or a stored statement when the retired source fails. */
class MemoryUnreadable extends Schema.TaggedError<MemoryUnreadable>()(
  'MemoryUnreadable',
  {},
  { title: 'Source memory cannot be read' },
) {}

// Vendored from main's memory contracts and HelixMemory adapter before their removal.
const Scope = Schema.TaggedUnion({
  Person: {},
  Company: {},
  Thread: { threadId: ThreadId, title: Schema.String },
})
const Partition = Schema.String.check(Schema.isPattern(/^[pc]-.+$/u))
const ScopeKey = Schema.String.check(Schema.isPattern(/^(company|person:.+|thread:.+)$/u))
const Record = Schema.Struct({
  memory: Schema.Struct({
    id: Schema.NonEmptyString,
    kind: MemoryKind,
    content: Schema.String,
    scope: Scope,
    learnedIn: Schema.NullOr(ThreadId),
    learnedFrom: Schema.Struct({ id: PersonId, name: Schema.String }),
    createdAt: Schema.Finite,
    updatedAt: Schema.Finite,
  }),
  aliases: Schema.Array(Schema.String),
  scope: ScopeKey,
})
const decodeEntry = Schema.decodeUnknownEffect(
  MemoryEntry.mapFields((fields) => ({ ...fields, updatedAt: Schema.Finite }), {
    unsafePreserveChecks: true,
  }),
)

/** Main's current(), including soft deletion and supersession, applies before every projection. */
const current = () =>
  Predicate.and([
    Predicate.eq('isLatest', true),
    Predicate.isNull('validTo'),
    Predicate.isNull('deletedAt'),
  ])

/** One Helix id always has the same address; the content prefix leaves twelve hash characters. */
const entryOf = ({ memory }: typeof Record.Type) => {
  const hash = NodeCrypto.createHash('sha256').update(memory.id).digest('hex').slice(0, 12)
  const slug = memory.content
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 50)
    .replace(/-$/u, '')
  const content = memory.content.trim()
  // A whole first word longer than 200 cannot meet the target contract; decoding fails closed.
  const description =
    content.length <= 200 ? content : content.slice(0, 201).replace(/\s+\S*$/u, '')
  const context = Scope.match(memory.scope, {
    Person: () => '',
    Company: () => '\n\nThis memory was for the whole Company.',
    Thread: ({ title }) => `\n\nThis memory was learned in the Thread "${title}".`,
  })
  return {
    layer: 'memory',
    file: slug.length === 0 ? `${hash}.md` : `${slug}-${hash}.md`,
    kind: memory.kind,
    description,
    body: memory.content + context,
    basis: 'said',
    updatedAt: memory.updatedAt,
  }
}

/** Every request here is a readBatch; this module has no Helix writes or DDL. */
const request = Effect.fn('HistoryReader.memoryRequest')(function* (
  url: URL,
  query: ReturnType<ReturnType<typeof readBatch>['toQueryRequest']>,
) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client
    .execute(
      HttpClientRequest.bodyText(
        HttpClientRequest.post(new URL('/v2/query', url)),
        query.toJsonString(),
        'application/json',
      ),
    )
    .pipe(Effect.mapError(() => new MemoryUnreadable()))
  if (response.status !== 200) return yield* new MemoryUnreadable()
  return response
})

/** Enumerate partitions, then main's scopes/visible queries without its 200-row UI list limit. */
export const readMemory = Effect.fn('HistoryReader.memory')(
  function* (url: URL) {
    const partitions = yield* request(
      url,
      readBatch()
        .varAs(
          'partitions',
          g()
            .nWithLabel('Memory')
            .where(current())
            .project([Projection.property('tenant_id', 'partition')]),
        )
        .returning(['partitions'])
        .toQueryRequest(),
    ).pipe(
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({
            partitions: Schema.Array(Schema.Struct({ partition: Partition })),
          }),
        ),
      ),
    )
    const people = new Map<PersonId, Array<RuntimeHistoryBody['memory'][number]>>()
    for (const partition of [
      ...new Set(partitions.partitions.map((row) => row.partition)),
    ].toSorted()) {
      const candidates = () =>
        g().nWithLabelWhere('Memory', SourcePredicate.eq('tenant_id', partition))
      const scopes = yield* request(
        url,
        readBatch()
          .varAs(
            'scopes',
            candidates()
              .where(current())
              .project([Projection.property('scope', 'scope')]),
          )
          .returning(['scopes'])
          .toQueryRequest(),
      ).pipe(
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(
            Schema.Struct({
              scopes: Schema.Array(Schema.Struct({ scope: ScopeKey })),
            }),
          ),
        ),
      )
      const rows = yield* request(
        url,
        readBatch()
          .varAs(
            'records',
            candidates()
              .where(
                Predicate.and([
                  Predicate.isIn('scope', [...new Set(scopes.scopes.map((row) => row.scope))]),
                  current(),
                ]),
              )
              .orderBy('createdAt', Order.Desc)
              .project([Projection.property('payload', 'record')]),
          )
          .returning(['records'])
          .toQueryRequest(),
      ).pipe(
        Effect.flatMap(
          HttpClientResponse.schemaBodyJson(
            Schema.Struct({
              records: Schema.Array(Schema.Struct({ record: Schema.fromJsonString(Record) })),
            }),
          ),
        ),
      )
      for (const { record } of rows.records.toSorted((a, b) =>
        a.record.memory.id.localeCompare(b.record.memory.id),
      )) {
        const entry = yield* decodeEntry(entryOf(record))
        const person = record.memory.learnedFrom.id
        const entries = people.get(person)
        if (entries === undefined) people.set(person, [entry])
        else entries.push(entry)
      }
    }
    return people
  },
  Effect.mapError(() => new MemoryUnreadable()),
)
