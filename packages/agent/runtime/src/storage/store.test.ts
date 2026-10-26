import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import type {
  ConversationId,
  DocumentId,
  EntryId,
  Storage,
  SubmissionId,
  TaskId,
} from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import { describe, expect, it } from '@effect/vitest'
import { PersonId } from '@vivid/contracts'
import { Effect, Exit, Option, Scope } from 'effect'
import { Pool, types } from 'pg'
import { afterAll, beforeAll, it as upstreamIt } from 'vitest'
import { databaseConfigured, disposableDatabase } from '../../tests/database.ts'
import { query, storesOn } from '../../tests/stores.ts'
import { PooledDatabase } from './driver.ts'
import { PostgresStore } from './store.ts'
import type { StoresService } from './stores.ts'

const context = BACKGROUND_CONTEXT
const ROOT = ROOT_CONVERSATION_ID

/** What the conformance cases share: one runtime's stores, and the scope that holds them. */
interface Shared {
  stores: Option.Option<StoresService>
  scope: Option.Option<Scope.Closeable>
}

/** A Person no other case has seen, so every case gets a store of its own. */
const stranger = () => PersonId.make(`person-${crypto.randomUUID()}`)

/**
 * Pi's own storage conformance suite (`@earendil-works/pi-durable/testing`), unmodified, through
 * the real driver. Every case opens a new store in one shared database under one runtime
 * authority, and the stores of earlier cases stay there with the same local ids (every store's
 * root is conversation 1 and its first minted id 2). A query that forgot its `store_id` would
 * meet those rows: an id already claimed, a scan with foreign records, a document address that is
 * already current.
 */
describe.skipIf(!databaseConfigured)('the conversation store against Pi’s contract', () => {
  const shared: Shared = { stores: Option.none(), scope: Option.none() }
  beforeAll(() =>
    // oxlint-disable-next-line vivid/no-manual-effect-runtime-in-tests, vivid/no-runpromise-in-library -- Pi's conformance runner registers plain Promise cases; this builds the one database they share.
    Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        shared.scope = Option.some(scope)
        const database = yield* disposableDatabase().pipe(Scope.provide(scope))
        shared.stores = Option.some(yield* storesOn(database).pipe(Scope.provide(scope)))
      }),
    ),
  )
  afterAll(() =>
    // oxlint-disable-next-line vivid/no-manual-effect-runtime-in-tests, vivid/no-runpromise-in-library -- The shared database's scope closes after Pi's Promise cases.
    Effect.runPromise(
      Option.match(shared.scope, {
        onNone: () => Effect.void,
        onSome: (scope) => Scope.close(scope, Exit.void),
      }),
    ),
  )
  registerStorageConformance(
    { describe, expect, it: upstreamIt },
    'Pi storage conformance, many stores in one database',
    (use) =>
      // oxlint-disable-next-line vivid/no-manual-effect-runtime-in-tests, vivid/no-runpromise-in-library -- Pi's conformance provider is a Promise callback.
      Effect.runPromise(
        Effect.flatMap(
          Option.match(shared.stores, {
            onNone: () => Effect.die(new Error('The shared database was not built')),
            onSome: Effect.succeed,
          }),
          (stores) => stores.open(stranger()),
        ),
      ).then((store) => use(store).finally(() => store.close(context))),
  )
})

/** The local ids one store hands out for the records `fill` writes. */
interface Filled {
  readonly entry: EntryId
  readonly task: TaskId<JsonValue>
  readonly submission: SubmissionId
  readonly document: DocumentId
  readonly fork: ConversationId
  readonly forked: EntryId
  readonly marker: EntryId
  readonly copy: DocumentId
  readonly latest: DocumentId
}

/**
 * Write one of every record kind into a store, each carrying the store's name: a root and a
 * forked conversation, entries on both sides of the fork, a task, a queued submission with a
 * request id, and a rewindable document with a base and a delta.
 */
const fill = Effect.fn('StoreTest.fill')(function* (storage: Storage, name: string) {
  const commit = (writes: Parameters<Storage['commit']>[0]) =>
    Effect.promise(() => storage.commit(writes, context))
  const mint = () => Effect.promise(() => storage.mintId<EntryId>())
  yield* commit([{ type: 'conversation', value: { id: ROOT } }])
  const entry = yield* mint()
  const task = yield* Effect.promise(() => storage.mintId<TaskId<JsonValue>>())
  const submission = yield* Effect.promise(() => storage.mintId<SubmissionId>())
  const document = yield* Effect.promise(() => storage.mintId<DocumentId>())
  yield* commit([
    { type: 'entry', value: { id: entry, conversationId: ROOT, kind: name } },
    {
      type: 'task',
      value: {
        id: task,
        conversationId: ROOT,
        kind: 'test.task',
        version: 1,
        input: { name },
        state: { status: 'pending', checkpoint: { name } },
        background: false,
        abortRequested: false,
      },
    },
    {
      type: 'submission',
      value: {
        id: submission,
        conversationId: ROOT,
        type: 'input',
        status: 'queued',
        requestId: 'the same request',
      },
    },
    {
      type: 'document.create',
      record: {
        id: document,
        kind: 'test.notes',
        scope: { kind: 'conversation', conversationId: ROOT },
        history: 'rewindable',
        fork: 'asOf',
      },
      content: { kind: 'base', version: 1, value: { name, count: 1 } },
    },
  ])
  yield* commit([
    {
      type: 'document.change',
      id: document,
      content: { kind: 'delta', version: 1, ops: [['s', ['count'], 2]] },
    },
  ])
  const fork = yield* Effect.promise(() => storage.mintId<ConversationId>())
  const forked = yield* mint()
  yield* commit([
    { type: 'conversation', value: { id: fork, parent: { conversationId: ROOT, at: entry } } },
    { type: 'entry', value: { id: forked, conversationId: fork, kind: `${name} forked` } },
  ])
  // A head marker, a copy of the rewindable document into the fork, and a document that keeps
  // only its latest content: each meets the same ids in the other store.
  const marker = yield* mint()
  const copy = yield* Effect.promise(() => storage.mintId<DocumentId>())
  const latest = yield* Effect.promise(() => storage.mintId<DocumentId>())
  yield* commit([
    {
      type: 'entry',
      value: { id: marker, conversationId: ROOT, kind: `${name} head`, head: entry },
    },
    {
      type: 'document.copy',
      record: {
        id: copy,
        kind: 'test.notes',
        scope: { kind: 'conversation', conversationId: fork },
        history: 'rewindable',
        fork: 'asOf',
      },
      source: { id: document, at: 'current' },
    },
    {
      type: 'document.create',
      record: {
        id: latest,
        kind: 'test.latest',
        scope: { kind: 'conversation', conversationId: ROOT },
        history: 'latest',
        fork: 'current',
      },
      content: { kind: 'base', version: 1, value: { name, round: 1 } },
    },
  ])
  return {
    entry,
    task,
    submission,
    document,
    fork,
    forked,
    marker,
    copy,
    latest,
  } satisfies Filled
})

/** Everything a store answers about the records `fill` wrote, by the ids it handed out. */
const read = Effect.fn('StoreTest.read')(function* (storage: Storage, ids: Filled) {
  const ask = <A>(call: () => Promise<A>) => Effect.promise(call)
  const entry = yield* ask(() => storage.entry(ids.entry, context))
  const task = yield* ask(() => storage.task(ids.task, context))
  const submission = yield* ask(() =>
    storage.submissionByRequest(ROOT, 'the same request', context),
  )
  const document = yield* ask(() => storage.document(ids.document, 'current', context))
  const marker = yield* ask(() => storage.findLatestHeadMarker(ROOT, undefined, context))
  const copy = yield* ask(() => storage.document(ids.copy, 'current', context))
  const latest = yield* ask(() => storage.document(ids.latest, 'current', context))
  const history = yield* ask(() =>
    storage.scanEntries({ conversationId: ids.fork, order: 'ascending' }, 10, undefined, context),
  )
  const conversations = yield* ask(() => storage.scanConversations({}, 10, undefined, context))
  const tasks = yield* ask(() => storage.scanTasks({}, 10, undefined, context))
  const submissions = yield* ask(() => storage.scanSubmissions({}, 10, undefined, context))
  const documents = yield* ask(() =>
    storage.scanDocuments(
      { scope: { kind: 'conversation', conversationId: ROOT }, at: 'current' },
      10,
      undefined,
      context,
    ),
  )
  return {
    entry: entry === undefined ? undefined : entry.entry.kind,
    task: task === undefined ? undefined : task.state.status,
    taskInput: task === undefined ? undefined : task.input,
    submission: submission === undefined ? undefined : submission.id,
    document: document === undefined ? undefined : document.value,
    marker: marker === undefined ? undefined : marker.kind,
    copy: copy === undefined ? undefined : copy.value,
    latest: latest === undefined ? undefined : latest.value,
    history: history.items.map((item) => item.kind),
    conversations: conversations.items.length,
    tasks: tasks.items.length,
    submissions: submissions.items.length,
    documents: documents.items.length,
  }
})

describe.skipIf(!databaseConfigured)('stores side by side', () => {
  it.effect('keeps two stores with the same local ids from seeing or changing each other', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stores = yield* storesOn(yield* disposableDatabase())
        const ada = yield* stores.open(PersonId.make('person-ada'))
        const grace = yield* stores.open(PersonId.make('person-grace'))
        const adaIds = yield* fill(ada, 'ada')
        const graceIds = yield* fill(grace, 'grace')
        // Same local ids in both: only the store tells them apart.
        expect(graceIds).toEqual(adaIds)

        const expected = (name: string) => ({
          entry: name,
          task: 'pending',
          taskInput: { name },
          submission: adaIds.submission,
          document: { name, count: 2 },
          marker: `${name} head`,
          copy: { name, count: 2 },
          latest: { name, round: 1 },
          history: [name, `${name} forked`],
          conversations: 2,
          tasks: 1,
          submissions: 1,
          documents: 2,
        })
        expect(yield* read(ada, adaIds)).toEqual(expected('ada'))
        expect(yield* read(grace, graceIds)).toEqual(expected('grace'))

        // Changing Ada's task, retiring her document and replacing the base of her latest-only
        // document (which deletes its earlier revisions) leaves Grace's as they were.
        const adaTask = yield* Effect.promise(() => ada.task(adaIds.task, context))
        if (adaTask === undefined) return yield* Effect.die(new Error('Ada has no task'))
        yield* Effect.promise(() =>
          ada.commit(
            [
              {
                type: 'task',
                value: { ...adaTask, state: { status: 'running', checkpoint: { name: 'ada' } } },
              },
              { type: 'document.retire', id: adaIds.document },
              {
                type: 'document.change',
                id: adaIds.latest,
                content: { kind: 'base', version: 2, value: { name: 'ada', round: 2 } },
              },
            ],
            context,
          ),
        )
        expect(yield* read(ada, adaIds)).toMatchObject({
          task: 'running',
          document: undefined,
          latest: { name: 'ada', round: 2 },
          documents: 1,
        })
        expect(yield* read(grace, graceIds)).toEqual(expected('grace'))
        // Each store numbers its own commits.
        const next = yield* Effect.promise(() =>
          Promise.all([ada, grace].map((store) => store.commit([], context))),
        )
        // Ada has committed six times, Grace five.
        expect(next).toEqual([7, 6])
      }),
    ),
  )

  it.effect('never hands out an id twice, also when one was minted and never used', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* disposableDatabase()
        const stores = yield* storesOn(database)
        const person = PersonId.make('person-ada')
        const first = yield* stores.open(person)
        const unused = yield* Effect.promise(() => first.mintId<EntryId>())
        yield* Effect.promise(() => first.close(context))
        const again = yield* stores.open(person)
        expect(yield* Effect.promise(() => again.mintId<EntryId>())).toBeGreaterThan(unused)
        // The reservation is durable: the store's watermark is past every id handed out.
        const [row] = yield* query(database, 'SELECT next_id::text AS next FROM runtime.metadata')
        expect(Number(row === undefined ? 0 : row['next'])).toBeGreaterThan(unused)
      }),
    ),
  )

  it.effect('keeps identities exact when the host parses BIGINT as a number', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* disposableDatabase()
        const made = yield* (yield* storesOn(database)).open(PersonId.make('person-ada'))
        // `Stores.open` answers Pi's `Storage`; this suite reopens the PostgreSQL store by its id.
        if (!(made instanceof PostgresStore)) throw new Error('Stores opened a store that is not PostgreSQL')
        const [owner] = yield* query(
          database,
          'SELECT generation::text AS generation, process FROM runtime.owner',
        )
        // A host pool whose connections turn INT8 into a JavaScript number (pg's documented
        // customisation), shared with this store as a production host could share it.
        const pool = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Pool({
                connectionString: database,
                types: {
                  // SAFETY: pg declares `getTypeParser` as format-keyed overloads; this answers both.
                  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
                    oid === types.builtins.INT8
                      ? (value: string) => Number(value)
                      : types.getTypeParser(oid, format)) as typeof types.getTypeParser,
                },
              }),
          ),
          (opened) => Effect.promise(() => opened.end()),
        )
        const store = yield* Effect.promise(() =>
          PostgresStore.open(
            new PooledDatabase(pool, {
              generation: String(owner === undefined ? '' : owner['generation']),
              process: String(owner === undefined ? '' : owner['process']),
            }),
            made.storeId,
          ),
        )
        const first = yield* Effect.promise(() =>
          store.commit([{ type: 'conversation', value: { id: ROOT } }], context),
        )
        const entry = yield* Effect.promise(() => store.mintId<EntryId>())
        const second = yield* Effect.promise(() =>
          store.commit(
            [{ type: 'entry', value: { id: entry, conversationId: ROOT, kind: 'exact' } }],
            context,
          ),
        )
        expect([first, second]).toEqual([1, 2])
      }),
    ),
  )

  it.effect('hands out increasing ids across reservation blocks and after a reopen', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stores = yield* storesOn(yield* disposableDatabase())
        const person = PersonId.make('person-ada')
        const first = yield* stores.open(person)
        // Three blocks of 64, from two callers at once on the second half.
        const early = yield* Effect.forEach(Array.from({ length: 100 }), () =>
          Effect.promise(() => first.mintId<EntryId>()),
        )
        const late = yield* Effect.forEach(
          Array.from({ length: 100 }),
          () => Effect.promise(() => first.mintId<EntryId>()),
          { concurrency: 2 },
        )
        const all = [...early, ...late]
        expect(new Set(all).size).toBe(200)
        expect(early.every((id, index) => index === 0 || id > (early[index - 1] ?? 0))).toBe(true)
        yield* Effect.promise(() => first.close(context))
        const again = yield* stores.open(person)
        expect(yield* Effect.promise(() => again.mintId<EntryId>())).toBeGreaterThan(
          Math.max(...all),
        )
      }),
    ),
  )

  it.effect('lists for recovery exactly the stores with a queued input or an unfinished task', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stores = yield* storesOn(yield* disposableDatabase())
        const opened = yield* Effect.forEach(
          ['person-idle', 'person-queued', 'person-waiting', 'person-finished'],
          (name) => stores.open(PersonId.make(name)),
        )
        const [idle, queued, waiting, finished] = opened
        if (
          idle === undefined ||
          queued === undefined ||
          waiting === undefined ||
          finished === undefined
        )
          return yield* Effect.die(new Error('Four stores were opened'))
        const commit = (store: Storage, writes: Parameters<Storage['commit']>[0]) =>
          Effect.promise(() => store.commit(writes, context))
        for (const store of opened)
          yield* commit(store, [{ type: 'conversation', value: { id: ROOT } }])
        const input = yield* Effect.promise(() => queued.mintId<SubmissionId>())
        yield* commit(queued, [
          {
            type: 'submission',
            value: { id: input, conversationId: ROOT, type: 'input', status: 'queued' },
          },
        ])
        const task = (id: TaskId<JsonValue>, state: 'waiting' | 'terminal') => ({
          type: 'task' as const,
          value:
            state === 'waiting'
              ? {
                  id,
                  conversationId: ROOT,
                  kind: 'test.task',
                  version: 1,
                  input: { state },
                  state: {
                    status: 'waiting' as const,
                    checkpoint: {},
                    on: [],
                    policy: 'failFast' as const,
                  },
                  background: true,
                  abortRequested: false,
                }
              : {
                  id,
                  conversationId: ROOT,
                  kind: 'test.task',
                  version: 1,
                  input: { state },
                  state: {
                    status: 'terminal' as const,
                    outcome: { status: 'completed' as const, result: null },
                  },
                  background: false,
                  abortRequested: false,
                },
        })
        yield* commit(waiting, [
          task(yield* Effect.promise(() => waiting.mintId<TaskId<JsonValue>>()), 'waiting'),
        ])
        yield* commit(finished, [
          task(yield* Effect.promise(() => finished.mintId<TaskId<JsonValue>>()), 'terminal'),
        ])
        expect(yield* stores.working).toEqual(['person-queued', 'person-waiting'])
      }),
    ),
  )
})
