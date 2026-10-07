import type {
  ConversationId,
  DocumentId,
  EntryId,
  SubmissionId,
  TaskId,
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import * as Option from 'effect/Option'
import { describe, expect, it } from 'vitest'
import {
  seedStorageWriteBenchmark,
  STORAGE_WRITE_BENCHMARKS,
} from '@earendil-works/pi-durable/testing'
import { CountingDatabase } from './bench/database.ts'
import { streamingWrites } from './bench/stream.ts'
import { openPgDatabase } from './pg.ts'
import { PostgresStorage } from './storage.ts'
import { postgresFixture } from './testing.ts'

const testUrl = Option.fromNullishOr(process.env['VIVID_TEST_DATABASE_URL'])
/** Counts successful driver calls through the actual facade, excluding setup.
 * No upstream test is altered; this also verifies the benchmark's expected values. */
describe.skipIf(Option.isNone(testUrl))('PostgreSQL round trips', () => {
  it('measures write benchmarks and streaming progress commits', async () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const database = new CountingDatabase(await openPgDatabase(fixture.pool, fixture.schema))
    const storage = await PostgresStorage.open(database, fixture.schema)
    fixture.track(storage)
    await seedStorageWriteBenchmark(storage)
    const measurements = []
    for (const benchmark of STORAGE_WRITE_BENCHMARKS) {
      database.calls = 0
      const begin = performance.now()
      expect(await benchmark.run(storage)).toBe(benchmark.expected)
      measurements.push({
        operation: benchmark.name,
        queries: database.calls,
        milliseconds: performance.now() - begin,
      })
    }
    for (const sample of await streamingWrites(storage)) {
      database.calls = 0
      const begin = performance.now()
      await storage.commit(sample.writes, BACKGROUND_CONTEXT)
      measurements.push({
        operation: sample.name,
        queries: database.calls,
        milliseconds: performance.now() - begin,
      })
    }
    for (const measurement of measurements) {
      if (
        measurement.operation === 'commit one entry' ||
        measurement.operation === 'commit 100 entries' ||
        measurement.operation === 'stream entry append' ||
        measurement.operation === 'stream submission + entry'
      )
        expect(measurement.queries).toBe(2)
    }
    console.log(JSON.stringify(measurements))
  })
  /** One statement snapshot replaces the document read transaction; scoped
   * ancestry keeps Pi's TEXT-only sequential lookups. Exercise actual
   * driver calls and lossless text containing SQL-looking data, NUL and surrogates. */
  it('reads global exact lookups in one call and keeps scoped ancestry as text', async () => {
    const fixture = postgresFixture(Option.getOrThrow(testUrl))
    const database = new CountingDatabase(await openPgDatabase(fixture.pool, fixture.schema))
    const storage = await PostgresStorage.open(database, fixture.schema)
    fixture.track(storage)
    const context = BACKGROUND_CONTEXT
    const root = await storage.mintId<ConversationId>()
    const child = await storage.mintId<ConversationId>()
    const entryId = await storage.mintId<EntryId>()
    const taskId = await storage.mintId<TaskId<JsonValue>>()
    const submissionId = await storage.mintId<SubmissionId>()
    const documentId = await storage.mintId<DocumentId>()
    const text = "'; DROP SCHEMA public CASCADE; --\n\\?\u0000\ud800"
    const rootRecord = { id: root, title: 'root\u0000\ud800' }
    const childRecord = {
      id: child,
      parent: { conversationId: root, at: entryId },
      title: 'child\u0000\ud800',
    }
    const entry = { id: entryId, conversationId: root, kind: text, data: { text } }
    const task = {
      id: taskId,
      conversationId: root,
      kind: text,
      version: 1,
      input: {},
      background: false,
      abortRequested: false,
      state: { status: 'running' as const, checkpoint: { text } },
    }
    const submission = {
      id: submissionId,
      conversationId: root,
      type: 'write' as const,
      status: 'done' as const,
      requestId: text,
      entry: entryId,
    }
    const record = { id: documentId, kind: text, scope: { kind: 'session' as const } }
    await storage.commit(
      [
        { type: 'conversation', value: rootRecord },
        {
          type: 'conversation',
          value: childRecord,
        },
        { type: 'entry', value: entry },
        { type: 'task', value: task },
        { type: 'submission', value: submission },
        { type: 'document.create', record, content: { kind: 'base', version: 1, value: { text } } },
      ],
      context,
    )
    expect(await storage.conversation(root, context)).toEqual(rootRecord)
    expect(await storage.conversation(child, context)).toEqual(childRecord)
    const lookups = [
      { run: () => storage.entry(entryId, context), expected: { entry }, calls: 1 },
      { run: () => storage.entry(child, entryId, context), expected: { entry }, calls: 3 },
      { run: () => storage.task(taskId, context), expected: task, calls: 1 },
      { run: () => storage.submission(submissionId, context), expected: submission, calls: 1 },
      {
        run: () => storage.submissionByRequest(root, text, context),
        expected: submission,
        calls: 1,
      },
      { run: () => storage.findDocument(record, 'current', context), expected: record, calls: 1 },
      {
        run: () => storage.document(documentId, 'current', context),
        expected: { record, value: { text } },
        calls: 1,
      },
    ]
    for (const lookup of lookups) {
      database.calls = 0
      expect(await lookup.run()).toMatchObject(lookup.expected)
      expect(database.calls).toBe(lookup.calls)
    }
    // Repeated mutable ids must execute two upserts in order. PostgreSQL multi-row
    // ON CONFLICT cannot do this; the ordered batch retains the last replacement.
    await storage.commit(
      [
        { type: 'task', value: { ...task, input: { order: 1 } } },
        { type: 'task', value: { ...task, input: { order: 2 } } },
      ],
      context,
    )
    expect(await storage.task(taskId, context)).toMatchObject({ input: { order: 2 } })
  })
})
