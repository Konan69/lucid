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
  InvalidRequest,
  NotFound,
  ServiceUnavailable,
  Workspace,
  type Person,
  type RememberRequest,
  type CorrectMemoryRequest,
} from '@vivid/contracts'
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

export type MemoryAccessFailure =
  | MemoryFailure
  | ExtractionFailure
  | DatabaseInfrastructureError
  | NotFound
  | InvalidRequest

export interface MemoryAccessService {
  readonly list: (actor: Actor) => Effect.Effect<ReadonlyArray<Memory>, MemoryAccessFailure>
  readonly brief: (actor: Actor) => Effect.Effect<MemoryBrief, MemoryAccessFailure>
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
  readonly actorFor: (
    thread: StoredThread,
    person: Person,
  ) => Effect.Effect<Actor, MemoryAccessFailure>
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

/** A Vivid call must still be in a visible Thread in the workspace its Actor names. */
const actingThread = Effect.fn('MemoryAccess.actingThread')(function* (actor: Actor) {
  if (actor.by === 'person') return Option.none<StoredThread>()
  if (Option.isNone(actor.threadId))
    return yield* Effect.fail(NotFound.make({ message: 'Thread not found' }))
  const thread = yield* requireThread(actor.threadId.value, actor.person.id)
  const belongs = Workspace.match(actor.workspace, {
    Personal: () => thread.companyId === null && thread.personId === actor.person.id,
    Company: ({ company }) => thread.companyId === company.id,
  })
  if (!belongs) return yield* Effect.fail(NotFound.make({ message: 'Thread not found' }))
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
    const sameWorkspace = Workspace.match(actor.workspace, {
      Personal: () => thread.value.companyId === null && thread.value.personId === actor.person.id,
      Company: ({ company }) => thread.value.companyId === company.id,
    })
    if (sameWorkspace && (yield* canSee(thread.value, actor.person.id))) visible.push(key)
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

/** Lookup only authorized partitions and scopes, hiding both absent and unauthorized identities behind NotFound. */
const writable = Effect.fn('MemoryAccess.writable')(function* (
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
    if (read.scopes.includes(key) && mayEdit(actor, memory.value))
      return { partition: read.partition, memory: memory.value }
  }
  return yield* Effect.fail(NotFound.make({ message: 'Memory not found' }))
})

interface AccessDependencies {
  readonly helix: HelixMemory['Service']
  readonly store: MemoryStore['Service']
  readonly database: Database['Service']
}

/** Every policy program uses the captured database, while Actor remains a per-call value. */
function accessReads(dependencies: AccessDependencies) {
  const { store, helix, database } = dependencies
  return {
    /** Merge newest first only after every partition has been queried with its explicit permitted scopes. */
    list: Effect.fn('MemoryAccess.list')(
      function* (actor: Actor) {
        const scopes = yield* readScopes(helix, actor)
        const pages = yield* Effect.forEach(scopes, (scope) => store.list(scope))
        return Arr.sortWith(pages.flat(), (memory) => memory.createdAt, Order.flip(Order.Number))
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
    /** A correction has exactly the same ownership gate as forgetting and retains the original attribution. */
    correct: Effect.fn('MemoryAccess.correct')(
      function* (actor: Actor, input: CorrectMemoryRequest) {
        const target = yield* writable(dependencies, actor, input.id)
        return yield* store.correct({
          partition: target.partition,
          id: input.id,
          content: input.content,
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

/** Model relationships cannot move private facts into a Company or another Thread; related ids must share the intended destination. */
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
  if (MemoryRelation.guards.new(candidate.relation))
    return Option.some((yield* rememberAt(store, actor, destination, candidate)).memory)
  const target = yield* writable(dependencies, actor, candidate.relation.id)
  const intended = location(destination.scope).scope
  const sameScope = MemoryScope.match(intended, {
    Person: () => MemoryScope.guards.Person(target.memory.scope),
    Company: () => MemoryScope.guards.Company(target.memory.scope),
    Thread: ({ threadId }) =>
      MemoryScope.guards.Thread(target.memory.scope) && target.memory.scope.threadId === threadId,
  })
  if (target.partition !== destination.partition || !sameScope)
    return yield* Effect.fail(
      InvalidRequest.make({ message: 'Memory relation crosses its write scope' }),
    )
  return yield* MemoryRelation.match(candidate.relation, {
    new: () => Effect.succeed(Option.none<Memory>()),
    duplicate: ({ id }) =>
      store
        .reinforce({ partition: target.partition, id, aliases: candidate.aliases })
        .pipe(Effect.map(Option.some)),
    updates: ({ id }) =>
      store
        .correct({ partition: target.partition, id, content: candidate.content })
        .pipe(Effect.map(Option.some)),
    extends: () =>
      Effect.gen(function* () {
        const saved = yield* rememberAt(store, actor, destination, candidate)
        if (saved.memory.id !== target.memory.id)
          yield* store.link({
            partition: target.partition,
            from: saved.memory.id,
            to: target.memory.id,
            kind: 'EXTENDS',
          })
        return Option.some(saved.memory)
      }),
  })
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
    (input: { readonly memories: ReadonlyArray<Memory>; readonly person: PersonSummary }) =>
      extraction.summarize(input),
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
      const text = yield* Cache.get(pages, { memories, person: summaryOf(actor.person) })
      return MemoryBrief.make({
        text,
        updatedAt: Math.max(...memories.map((memory) => memory.updatedAt)),
      })
    }),
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
    recall: Effect.fn('MemoryAccess.unconfigured.recall')(() => unconfiguredMemory),
    remember: Effect.fn('MemoryAccess.unconfigured.remember')(() => unconfiguredMemory),
    correct: Effect.fn('MemoryAccess.unconfigured.correct')(() => unconfiguredMemory),
    forget: Effect.fn('MemoryAccess.unconfigured.forget')(() => unconfiguredMemory),
    learn: Effect.fn('MemoryAccess.unconfigured.learn')(() => unconfiguredMemory),
    actorFor: Effect.fn('MemoryAccess.unconfigured.actorFor')(() => unconfiguredMemory),
  }),
)
