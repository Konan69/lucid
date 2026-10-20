import * as NodeCrypto from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, layer } from '@effect/vitest'
import {
  ArtifactAuthor,
  ArtifactChanged,
  ReadDocumentOutcome,
  CompanyId,
  Person,
  PersonId,
  RunId,
  ThreadId,
} from '@vivid/contracts'
import { Clock, Context, Effect, Layer, Ref, Result, Schema, Stream } from 'effect'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, Topic } from '../live/changes.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { runs, threadParticipants, threads } from '../threads/tables.ts'
import { ArtifactStore, artifactStoreLayer } from './store.ts'
import { artifactVersions, artifacts } from './tables.ts'

class Published extends Context.Service<Published, Ref.Ref<ReadonlyArray<Topic>>>()(
  'artifacts/test/Published',
) {}
/** Observe committed invalidations without depending on LISTEN/NOTIFY timing. */
const changesLayer = Layer.effectContext(
  Effect.gen(function* () {
    const published = yield* Ref.make<ReadonlyArray<Topic>>([])
    return Context.make(
      Changes,
      Changes.of({
        publish: (topics) => Ref.update(published, (values) => [...values, ...topics]),
        subscribe: () => Effect.succeed(Stream.never),
      }),
    ).pipe(Context.add(Published, published))
  }),
)
const testLayer = artifactStoreLayer.pipe(
  Layer.provideMerge(Layer.merge(testDatabaseLayer, changesLayer)),
)
const encodeOrigin = Schema.encodeSync(StoredRunOrigin)

/** Only isolated test configuration is used, and cleanup is registered before the first write. */
const fixture = Effect.fn('Artifacts.test.fixture')(function* () {
  const database = yield* Database
  const people = ['Creator', 'Member', 'Admin', 'Outsider'].map((name) =>
    Person.make({
      id: PersonId.make(NodeCrypto.randomUUID()),
      name,
      email: `${NodeCrypto.randomUUID()}@example.test`,
      image: null,
    }),
  )
  const [person, member, admin, outsider] = people
  if (person === undefined || member === undefined || admin === undefined || outsider === undefined)
    return yield* Effect.die('Missing fixture Person')
  const companyId = CompanyId.make(NodeCrypto.randomUUID())
  const threadId = ThreadId.make(NodeCrypto.randomUUID())
  const runId = RunId.make(NodeCrypto.randomUUID())
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* database.run(database.delete(companyTable).where(eq(companyTable.id, companyId)))
      yield* database.run(
        database.delete(personTable).where(
          inArray(
            personTable.id,
            people.map((value) => value.id),
          ),
        ),
      )
    }).pipe(
      Effect.catch((error) => Effect.logError('Artifact fixture cleanup failed', error._tag)),
    ),
  )
  yield* database.run(
    database
      .insert(personTable)
      .values(people.map((value) => ({ id: value.id, name: value.name, email: value.email }))),
  )
  yield* database.run(
    database
      .insert(companyTable)
      .values({ id: companyId, name: 'Test Company', slug: NodeCrypto.randomUUID() }),
  )
  yield* database.run(
    database.insert(membershipTable).values([
      { id: NodeCrypto.randomUUID(), companyId, userId: person.id, role: 'owner' },
      { id: NodeCrypto.randomUUID(), companyId, userId: member.id, role: 'member' },
      { id: NodeCrypto.randomUUID(), companyId, userId: admin.id, role: 'admin' },
    ]),
  )
  yield* database.run(
    database.insert(threads).values({
      id: threadId,
      title: 'Documents',
      titleSource: 'Person',
      personId: person.id,
      companyId,
      audience: 'private',
      updatedAt: yield* Clock.currentTimeMillis,
    }),
  )
  yield* database.run(
    database.insert(runs).values({
      id: runId,
      threadId,
      personId: person.id,
      turn: 1,
      state: 'working',
      origin: encodeOrigin(StoredRunOrigin.cases.Message.make({})),
      startedAt: yield* Clock.currentTimeMillis,
    }),
  )
  return { database, person, member, admin, outsider, threadId, runId, companyId }
})

/** Real SQL proves history, uniqueness, rollback, optimistic editing and access across workspaces. */
describe.skipIf(!testDatabaseConfigured)('Thread documents', () => {
  layer(testLayer)((it) => {
    it.effect(
      'writes a private Thread with working Run attribution, history and identical-body receipts',
      () =>
        Effect.gen(function* () {
          const { person, threadId, runId } = yield* fixture()
          const store = yield* ArtifactStore
          const first = yield* store.write(person.id, threadId, {
            title: 'Launch plan',
            body: '# Plan\n\nFirst.',
            note: 'Ignored on creation',
          })
          expect(first).toEqual({ title: 'Launch plan', version: 1, created: true, changed: true })
          const revised = yield* store.write(person.id, threadId, {
            title: 'LAUNCH PLAN',
            body: '# Plan\n\nSecond.',
            note: 'Changed scope',
          })
          expect(revised).toEqual({
            title: 'Launch plan',
            version: 2,
            created: false,
            changed: true,
          })
          const published = yield* Ref.get(yield* Published)
          expect(
            yield* store.write(person.id, threadId, {
              title: 'launch plan',
              body: '# Plan\n\nSecond.',
              note: 'Do not save',
            }),
          ).toEqual({ ...revised, changed: false })
          expect(yield* Ref.get(yield* Published)).toEqual(published)
          const list = yield* store.list(person.id, threadId)
          expect(list).toHaveLength(1)
          const artifact = list[0]
          if (artifact === undefined) return yield* Effect.die('Document missing')
          const detail = yield* store.get(person.id, { id: artifact.id, version: 1 })
          expect(detail.body).toBe('# Plan\n\nFirst.')
          expect(detail.versions.map((version) => version.number)).toEqual([2, 1])
          expect(detail.shown).not.toHaveProperty('note')
          expect(detail.versions[0]).toMatchObject({
            note: 'Changed scope',
            madeBy: ArtifactAuthor.cases.Vivid.make({ runId }),
          })
          expect(yield* store.read(person.id, threadId, { title: 'LAUNCH PLAN' })).toEqual(
            ReadDocumentOutcome.cases.Found.make({
              title: 'Launch plan',
              version: 2,
              body: '# Plan\n\nSecond.',
            }),
          )
          expect(yield* store.read(person.id, threadId, { title: 'Missing' })).toEqual(
            ReadDocumentOutcome.cases.Missing.make({ titles: ['Launch plan'] }),
          )
          expect(
            (yield* Effect.flip(store.get(person.id, { id: artifact.id, version: 3 })))._tag,
          ).toBe('NotFound')
          expect(published.filter((topic) => topic === Topic.thread(threadId))).toHaveLength(2)
          return yield* Effect.void
        }),
    )

    it.effect('attributes writes in a shared Thread to its working Run without a turn', () =>
      Effect.gen(function* () {
        const { database, person, member, threadId, runId } = yield* fixture()
        const store = yield* ArtifactStore
        yield* database.run(
          database.update(threads).set({ audience: 'company' }).where(eq(threads.id, threadId)),
        )
        yield* database.run(
          database.update(runs).set({ personId: member.id }).where(eq(runs.id, runId)),
        )
        expect(
          yield* store.write(member.id, threadId, { title: 'Shared plan', body: '# Shared' }),
        ).toMatchObject({ version: 1, created: true, changed: true })
        const [artifact] = yield* store.list(person.id, threadId)
        if (artifact === undefined) return yield* Effect.die('Document missing')
        expect((yield* store.get(person.id, { id: artifact.id })).shown.madeBy).toEqual(
          ArtifactAuthor.cases.Vivid.make({ runId }),
        )
        expect(yield* store.read(member.id, threadId, { title: 'Shared plan' })).toEqual(
          ReadDocumentOutcome.cases.Found.make({
            title: 'Shared plan',
            version: 1,
            body: '# Shared',
          }),
        )
        return yield* Effect.void
      }),
    )

    it.effect(
      'refuses ended and other-Person Runs, and gives a joined delivery\'s write to its host Run',
      () =>
        Effect.gen(function* () {
          const { database, person, member, threadId, runId } = yield* fixture()
          const store = yield* ArtifactStore
          const request = { title: 'Not saved', body: 'Never saved' }
          yield* database.run(
            database.update(threads).set({ audience: 'company' }).where(eq(threads.id, threadId)),
          )
          expect((yield* Effect.flip(store.write(member.id, threadId, request)))._tag).toBe(
            'NotFound',
          )
          yield* database.run(
            database
              .update(runs)
              .set({ state: 'completed', finishedAt: 2 })
              .where(eq(runs.id, runId)),
          )
          expect((yield* Effect.flip(store.write(person.id, threadId, request)))._tag).toBe(
            'NotFound',
          )
          yield* database.run(
            database
              .update(runs)
              .set({ state: 'working', finishedAt: null })
              .where(eq(runs.id, runId)),
          )
          // Another Person's working Run in the Thread leaves the write with no honest author.
          const theirs = RunId.make(NodeCrypto.randomUUID())
          yield* database.run(
            database.insert(runs).values({
              id: theirs,
              threadId,
              personId: member.id,
              turn: 2,
              state: 'working',
              origin: encodeOrigin(StoredRunOrigin.cases.Message.make({})),
              startedAt: 2,
            }),
          )
          expect((yield* Effect.flip(store.write(person.id, threadId, request)))._tag).toBe(
            'NotFound',
          )
          expect(yield* store.list(person.id, threadId)).toEqual([])
          expect(yield* Ref.get(yield* Published)).not.toContain(Topic.thread(threadId))
          // The same Person's delivery joining the response (an answer to a question Vivid asked)
          // is a second working Run; the write belongs to the response's host, the earlier Run.
          yield* database.run(database.delete(runs).where(eq(runs.id, theirs)))
          yield* database.run(
            database.insert(runs).values({
              id: RunId.make(NodeCrypto.randomUUID()),
              threadId,
              personId: person.id,
              turn: 3,
              state: 'working',
              origin: encodeOrigin(StoredRunOrigin.cases.Decision.make({})),
              startedAt: 3,
            }),
          )
          expect(yield* store.write(person.id, threadId, request)).toMatchObject({ created: true })
          const [written] = yield* store.list(person.id, threadId)
          if (written === undefined) return yield* Effect.sync(() => expect.fail('Not written'))
          expect((yield* store.get(person.id, { id: written.id })).shown.madeBy).toEqual(
            ArtifactAuthor.cases.Vivid.make({ runId }),
          )
        }),
    )

    it.effect(
      'serializes competing new titles, identical retries and concurrent Person revisions',
      () =>
        Effect.gen(function* () {
          const { person, threadId } = yield* fixture()
          const store = yield* ArtifactStore
          const writes = yield* Effect.all(
            [
              store.write(person.id, threadId, { title: 'Plan', body: 'First' }),
              store.write(person.id, threadId, { title: 'PLAN', body: 'Second' }),
            ],
            { concurrency: 2 },
          )
          expect(writes.map((value) => value.version)).toEqual(expect.arrayContaining([1, 2]))
          const [artifact] = yield* store.list(person.id, threadId)
          if (artifact === undefined) return yield* Effect.die('Document missing')
          const outcomes = yield* Effect.all(
            [
              Effect.result(
                store.revise(person, {
                  id: artifact.id,
                  from: 2,
                  body: 'Person A',
                  note: 'Edited',
                }),
              ),
              Effect.result(store.revise(person, { id: artifact.id, from: 2, body: 'Person B' })),
            ],
            { concurrency: 2 },
          )
          const errors = outcomes.filter(Result.isFailure)
          expect(errors).toHaveLength(1)
          expect(errors[0]).toMatchObject({
            failure: new ArtifactChanged({ id: artifact.id, version: 3 }),
          })
          const detail = yield* store.get(person.id, { id: artifact.id })
          expect(detail.versions).toHaveLength(3)
          const [firstOutcome] = outcomes
          if (firstOutcome === undefined) expect.fail('Expected both revision receipts')
          expect(detail.body).toBe(Result.isSuccess(firstOutcome) ? 'Person A' : 'Person B')
          expect(detail.shown.madeBy).toEqual(
            ArtifactAuthor.cases.Person.make({
              person: { id: person.id, name: person.name, image: null },
            }),
          )
          yield* Effect.forEach(
            [1, 2, 3],
            () => store.write(person.id, threadId, { title: 'plan', body: detail.body }),
            { concurrency: 3 },
          )
          expect((yield* store.get(person.id, { id: artifact.id })).versions).toHaveLength(3)
          return yield* Effect.void
        }),
    )

    it.effect(
      'inherits Thread visibility, permits participant edits, and requires visible owner/admin removal',
      () =>
        Effect.gen(function* () {
          const { database, person, member, admin, outsider, threadId, companyId } =
            yield* fixture()
          const store = yield* ArtifactStore
          yield* store.write(person.id, threadId, {
            title: 'Private',
            body: 'Private content',
          })
          const [artifact] = yield* store.list(person.id, threadId)
          if (artifact === undefined) return yield* Effect.die('Document missing')
          for (const other of [member, admin, outsider]) {
            expect((yield* Effect.flip(store.list(other.id, threadId)))._tag).toBe('NotFound')
            expect((yield* Effect.flip(store.get(other.id, { id: artifact.id })))._tag).toBe(
              'NotFound',
            )
            expect(
              (yield* Effect.flip(store.revise(other, { id: artifact.id, from: 1, body: 'Probe' })))
                ._tag,
            ).toBe('NotFound')
            expect((yield* Effect.flip(store.remove(other.id, artifact.id)))._tag).toBe('NotFound')
          }
          yield* database.run(
            database.update(threads).set({ audience: 'people' }).where(eq(threads.id, threadId)),
          )
          yield* database.run(
            database
              .insert(threadParticipants)
              .values({ threadId, personId: member.id, addedAt: 0 }),
          )
          expect(
            (yield* store.revise(member, { id: artifact.id, from: 1, body: 'Reviewed' })).version,
          ).toBe(2)
          expect((yield* Effect.flip(store.remove(member.id, artifact.id)))._tag).toBe('Forbidden')
          yield* database.run(
            database.update(threads).set({ audience: 'company' }).where(eq(threads.id, threadId)),
          )
          yield* database.run(
            database
              .delete(membershipTable)
              .where(
                and(
                  eq(membershipTable.companyId, companyId),
                  eq(membershipTable.userId, member.id),
                ),
              ),
          )
          expect((yield* Effect.flip(store.list(member.id, threadId)))._tag).toBe('NotFound')
          yield* store.remove(admin.id, artifact.id)
          expect(yield* store.list(person.id, threadId)).toEqual([])
          expect(
            yield* database.run(
              database
                .select()
                .from(artifactVersions)
                .where(eq(artifactVersions.artifactId, artifact.id)),
            ),
          ).toEqual([])
          return yield* Effect.void
        }),
    )

    it.effect(
      'allows owner removal and cascades documents and every version when the Thread is deleted',
      () =>
        Effect.gen(function* () {
          const { database, person, threadId } = yield* fixture()
          const store = yield* ArtifactStore
          yield* store.write(person.id, threadId, { title: 'Remove me', body: 'First' })
          const [first] = yield* store.list(person.id, threadId)
          if (first === undefined) return yield* Effect.die('Document missing')
          yield* store.remove(person.id, first.id)
          yield* store.write(person.id, threadId, { title: 'Cascaded', body: 'First' })
          yield* store.write(person.id, threadId, { title: 'Cascaded', body: 'Second' })
          const [second] = yield* store.list(person.id, threadId)
          if (second === undefined) return yield* Effect.die('Document missing')
          yield* database.run(database.delete(threads).where(eq(threads.id, threadId)))
          expect(
            yield* database.run(
              database.select().from(artifacts).where(eq(artifacts.threadId, threadId)),
            ),
          ).toEqual([])
          expect(
            yield* database.run(
              database
                .select()
                .from(artifactVersions)
                .where(eq(artifactVersions.artifactId, second.id)),
            ),
          ).toEqual([])
          return yield* Effect.void
        }),
    )
  })
})
