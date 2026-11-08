import { testSubmissionId } from '../approvals/testing.ts'
import * as NodeCrypto from 'node:crypto'
import * as NodePath from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, layer } from '@effect/vitest'
import {
  ArtifactAuthor,
  ArtifactContent,
  ArtifactSource,
  ArtifactPreview,
  SessionId,
  ArtifactChanged,
  ReadDocumentOutcome,
  CompanyId,
  DocumentToolCallId,
  Person,
  PersonId,
  RunId,
  ThreadId,
} from '@vivid/contracts'
import { Clock, Context, Effect, Layer, Ref, Result, Schema, Stream } from 'effect'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { personTable, sessionTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Changes, Topic } from '../live/changes.ts'
import { Runtime } from '../runtime/client.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { runs, threadParticipants, threads } from '../threads/tables.ts'
import { ArtifactStore, artifactStoreLayer } from './store.ts'
import { artifactVersions, artifacts } from './tables.ts'
import { keepInspection, publishArtifactFile } from './files.ts'
import { capturedFile, FileCapture } from './render.ts'
import { artifactBytesRoutes } from './bytes.ts'
import { peer, peerAvailable } from '../computers/ssh/peer.ts'
import { openLink } from '../computers/ssh/link.ts'
import { authLayer } from '../auth/provider.ts'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

class Published extends Context.Service<Published, Ref.Ref<ReadonlyArray<Topic>>>()(
  'artifacts/test/Published',
) {}
const documentCall = DocumentToolCallId.make('write-document')
interface ResponseRecord {
  readonly threadId: ThreadId
  readonly runId: RunId
  readonly toolCallId: DocumentToolCallId
  readonly toolName: 'write_document' | 'inspect_file' | 'publish_file'
  readonly settled: boolean
}
class Responses extends Context.Service<Responses, Ref.Ref<ReadonlyArray<ResponseRecord>>>()(
  'artifacts/test/Responses',
) {}
/** Public conversation history varies independently from product Run settlement. */
const runtimeHistoryLayer = Layer.effectContext(
  Effect.gen(function* () {
    const responses = yield* Ref.make<ReadonlyArray<ResponseRecord>>([])
    const runtime = Runtime.of({
      admit: () => Effect.die('Artifact tests do not admit deliveries'),
      settled: () => Effect.never,
      stop: () => Effect.die('Artifact tests do not stop responses'),
      child: () => Effect.die('Artifact tests start no helpers'),
      stopChild: () => Effect.die('Artifact tests start no helpers'),
      watch: () => Stream.never,
      read: Effect.fn('Artifacts.test.history')(function* ({ threadId }) {
        const history = (yield* Ref.get(responses)).filter((entry) => entry.threadId === threadId)
        return HttpClientResponse.fromWeb(
          HttpClientRequest.get('https://runtime.example.test'),
          new Response(
            JSON.stringify({
              working: false,
              queued: 0,
              messages: history.map((entry, index) => ({
                id: `document-${index}`,
                purpose: 'assistant',
                display: 'visible',
                role: 'assistant',
                submissionId: String(testSubmissionId(entry.runId)),
                parts: [
                  {
                    type: 'dynamic-tool',
                    toolName: entry.toolName,
                    toolCallId: entry.toolCallId,
                    state: 'input-available',
                    input: {},
                  },
                ],
              })),
              settlements: history
                .filter((entry) => entry.settled)
                .map((entry) => ({
                  submissionId: String(testSubmissionId(entry.runId)),
                  outcome: 'completed',
                })),
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )
      }),
    })
    return Context.make(Runtime, runtime).pipe(Context.add(Responses, responses))
  }),
)
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
  Layer.provideMerge(
    Layer.mergeAll(
      testDatabaseLayer,
      changesLayer,
      runtimeHistoryLayer,
      authLayer.pipe(Layer.provide(testConfigLayer)),
    ),
  ),
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
      admittedAt: yield* Clock.currentTimeMillis,
      receipt: { runId, submissionId: String(testSubmissionId(runId)) },
    }),
  )
  yield* Ref.update(yield* Responses, (entries) => [
    ...entries,
    {
      threadId,
      runId,
      toolCallId: documentCall,
      settled: false,
      toolName: 'write_document' as const,
    },
  ])
  return { database, person, member, admin, outsider, threadId, runId, companyId }
})

/** Real SQL proves history, uniqueness, rollback, optimistic editing and access across workspaces. */
describe.skipIf(!testDatabaseConfigured)('Thread documents', () => {
  layer(testLayer)((it) => {
    it.effect.skipIf(!peerAvailable)(
      'publishes captured SSH bytes once and downloads them only with Thread access',
      () =>
        Effect.gen(function* () {
          const { database, person, outsider, threadId, runId } = yield* fixture()
          const server = yield* peer()
          const link = yield* openLink(server)
          const outputPath = NodePath.join(server.home, 'output.png')
          const sourcePath = NodePath.join(server.home, 'editable.docx')
          const original = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128])
          const source = Uint8Array.from([80, 75, 3, 4, 0, 128, 255, 10])
          yield* link.put(outputPath, original)
          yield* link.put(sourcePath, source)
          const outputBytes = yield* link.read(outputPath)
          const sourceBytes = yield* link.read(sourcePath)
          const inspectionCall = DocumentToolCallId.make('inspect-captured-file')
          const publicationCall = DocumentToolCallId.make('publish-captured-file')
          yield* Ref.update(yield* Responses, (entries) => [
            ...entries,
            {
              threadId,
              runId,
              toolCallId: inspectionCall,
              settled: false,
              toolName: 'inspect_file' as const,
            },
            {
              threadId,
              runId,
              toolCallId: publicationCall,
              settled: false,
              toolName: 'publish_file' as const,
            },
          ])
          const inspected = yield* keepInspection(
            { personId: person.id, threadId, runId, toolCallId: inspectionCall },
            {
              capture: FileCapture.make({
                output: capturedFile('output.png', outputBytes),
                source: ArtifactSource.cases.Separate.make({
                  file: capturedFile('editable.docx', sourceBytes),
                }),
                preview: ArtifactPreview.cases.Output.make({}),
              }),
              output: outputBytes,
              source: sourceBytes,
              preview: null,
            },
          )
          expect(inspected.picture).toEqual(original)
          yield* link.put(sourcePath, new TextEncoder().encode('changed source after inspection'))
          yield* link.put(outputPath, new TextEncoder().encode('changed output after inspection'))
          const request = {
            inspection: inspected.inspection,
            toolCallId: publicationCall,
            title: 'Captured file',
            review: 'Fixture preview checks immutable byte transport only.',
          }
          const [first, retried] = yield* Effect.all(
            [
              publishArtifactFile(person.id, threadId, request),
              publishArtifactFile(person.id, threadId, request),
            ],
            { concurrency: 2 },
          )
          expect(retried).toEqual(first)
          const store = yield* ArtifactStore
          const detail = yield* store.get(person.id, { id: first.artifact.id })
          expect(detail.versions).toHaveLength(1)
          expect(ArtifactContent.guards.File(detail.content)).toBe(true)
          expect(detail.content).toMatchObject({
            output: { sha256: NodeCrypto.createHash('sha256').update(original).digest('hex') },
          })
          expect(
            (yield* Effect.flip(
              store.revise(person, {
                id: first.artifact.id,
                from: 1,
                body: 'Must not replace bytes',
              }),
            ))._tag,
          ).toBe('ArtifactNotEditable')
          yield* database.run(
            database
              .update(runs)
              .set({ state: 'completed', finishedAt: 2 })
              .where(eq(runs.id, runId)),
          )
          expect(yield* publishArtifactFile(person.id, threadId, request)).toEqual(first)
          const session = Effect.fn('Artifacts.test.session')(function* (id: PersonId) {
            const token = NodeCrypto.randomUUID()
            yield* database.run(
              database.insert(sessionTable).values({
                id: SessionId.make(NodeCrypto.randomUUID()),
                token,
                userId: id,
                expiresAt: new Date(Date.now() + 60_000),
              }),
            )
            return token
          })
          const ownerToken = yield* session(person.id)
          const outsiderToken = yield* session(outsider.id)
          const handle = yield* HttpRouter.toHttpEffect(artifactBytesRoutes)
          const download = Effect.fn('Artifacts.test.download')(function* (
            role: string,
            token: string,
          ) {
            const response = yield* handle.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(
                    `http://vivid.test/api/artifacts/${first.artifact.id}/versions/1/files/${role}`,
                    { headers: { authorization: `Bearer ${token}` } },
                  ),
                ),
              ),
              Effect.scoped,
            )
            return HttpServerResponse.toWeb(response)
          })
          for (const [role, expected] of [
            ['output', original],
            ['source', source],
          ] as const) {
            const response = yield* download(role, ownerToken)
            expect(response.status).toBe(200)
            const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))
            expect(bytes).toEqual(expected)
            expect(NodeCrypto.createHash('sha256').update(bytes).digest('hex')).toBe(
              NodeCrypto.createHash('sha256').update(expected).digest('hex'),
            )
            const refused = yield* download(role, outsiderToken)
            expect(refused.status).toBe(404)
            expect((yield* Effect.promise(() => refused.arrayBuffer())).byteLength).toBe(0)
          }
          const fileResponse = yield* download('source', ownerToken)
          expect(fileResponse.headers.get('content-type')).toContain(
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          )
          expect(fileResponse.headers.get('content-disposition')).toContain('attachment;')
        }),
    )

    it.effect(
      'writes a private Thread with working Run attribution, history and identical-body receipts',
      () =>
        Effect.gen(function* () {
          const { person, threadId, runId } = yield* fixture()
          const store = yield* ArtifactStore
          const first = yield* store.write(person.id, threadId, {
            toolCallId: documentCall,
            title: 'Launch plan',
            body: '# Plan\n\nFirst.',
            note: 'Ignored on creation',
          })
          expect(first).toMatchObject({
            title: 'Launch plan',
            version: 1,
            created: true,
            changed: true,
          })
          const revised = yield* store.write(person.id, threadId, {
            toolCallId: documentCall,
            title: 'LAUNCH PLAN',
            body: '# Plan\n\nSecond.',
            note: 'Changed scope',
          })
          expect(revised).toMatchObject({
            title: 'Launch plan',
            version: 2,
            created: false,
            changed: true,
          })
          const published = yield* Ref.get(yield* Published)
          expect(
            yield* store.write(person.id, threadId, {
              toolCallId: documentCall,
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
          expect(detail.content).toEqual(
            ArtifactContent.cases.Document.make({ body: '# Plan\n\nFirst.' }),
          )
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
          yield* store.write(member.id, threadId, {
            toolCallId: documentCall,
            title: 'Shared plan',
            body: '# Shared',
          }),
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

    it.effect('only admitted Runs can author a document, ignoring earlier reservations', () =>
      Effect.gen(function* () {
        const { database, person, threadId, runId } = yield* fixture()
        const store = yield* ArtifactStore
        yield* database.run(
          database.update(runs).set({ turn: 2, admittedAt: null }).where(eq(runs.id, runId)),
        )
        const request = { toolCallId: documentCall, title: 'Packing', body: 'Pack a coat.' }
        expect((yield* Effect.flip(store.write(person.id, threadId, request)))._tag).toBe(
          'NotFound',
        )
        expect(yield* store.list(person.id, threadId)).toEqual([])
        yield* database.run(database.update(runs).set({ admittedAt: 2 }).where(eq(runs.id, runId)))
        // A reservation left behind before acceptance has no response that could write this.
        yield* database.run(
          database.insert(runs).values({
            id: RunId.make(NodeCrypto.randomUUID()),
            threadId,
            personId: person.id,
            turn: 1,
            state: 'working',
            origin: encodeOrigin(StoredRunOrigin.cases.Message.make({})),
            startedAt: 1,
          }),
        )
        yield* store.write(person.id, threadId, request)
        const [written] = yield* store.list(person.id, threadId)
        if (written === undefined) return yield* Effect.sync(() => expect.fail('Not written'))
        expect((yield* store.get(person.id, { id: written.id })).shown.madeBy).toEqual(
          ArtifactAuthor.cases.Vivid.make({ runId }),
        )
      }),
    )

    it.effect(
      "refuses ended and other-Person Runs, and gives a joined delivery's write to its host Run",
      () =>
        Effect.gen(function* () {
          const { database, person, member, threadId, runId } = yield* fixture()
          const store = yield* ArtifactStore
          const request = { toolCallId: documentCall, title: 'Not saved', body: 'Never saved' }
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
          // A visible Thread does not let the caller author another Person's exact response.
          const theirs = RunId.make(NodeCrypto.randomUUID())
          const theirCall = DocumentToolCallId.make('other-person-call')
          yield* database.run(
            database.insert(runs).values({
              id: theirs,
              threadId,
              personId: member.id,
              turn: 2,
              state: 'working',
              origin: encodeOrigin(StoredRunOrigin.cases.Message.make({})),
              startedAt: 2,
              admittedAt: 2,
            }),
          )
          yield* Ref.update(yield* Responses, (entries) => [
            ...entries,
            {
              threadId,
              runId: theirs,
              toolCallId: theirCall,
              settled: false,
              toolName: 'write_document' as const,
            },
          ])
          expect(
            (yield* Effect.flip(
              store.write(person.id, threadId, { ...request, toolCallId: theirCall }),
            ))._tag,
          ).toBe('NotFound')
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
              admittedAt: 3,
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

    it.effect('attributes a late answer to response B while A product settlement stays stale', () =>
      Effect.gen(function* () {
        const { database, person, threadId, runId: earlier } = yield* fixture()
        const store = yield* ArtifactStore
        const later = RunId.make(NodeCrypto.randomUUID())
        const laterCall = DocumentToolCallId.make('late-answer-document')
        // The runtime completed A and started B from the late answer; the product observer has not
        // settled A yet. Both admitted product rows intentionally remain working throughout.
        yield* database.run(
          database.insert(runs).values({
            id: later,
            receipt: { runId: later, submissionId: String(testSubmissionId(later)) },
            threadId,
            personId: person.id,
            turn: 2,
            state: 'working',
            origin: encodeOrigin(StoredRunOrigin.cases.Decision.make({})),
            startedAt: 2,
            admittedAt: 2,
          }),
        )
        yield* Ref.update(yield* Responses, (entries) => [
          ...entries.map((entry) =>
            entry.runId === earlier ? { ...entry, settled: true } : entry,
          ),
          {
            threadId,
            runId: later,
            toolCallId: laterCall,
            settled: false,
            toolName: 'write_document' as const,
          },
        ])
        yield* store.write(person.id, threadId, {
          toolCallId: laterCall,
          title: 'The late answer',
          body: 'Written by response B.',
        })
        const [artifact] = yield* store.list(person.id, threadId)
        if (artifact === undefined) return yield* Effect.die('Document missing')
        expect((yield* store.get(person.id, { id: artifact.id })).shown.madeBy).toEqual(
          ArtifactAuthor.cases.Vivid.make({ runId: later }),
        )
        const working = yield* database.run(
          database
            .select({ id: runs.id, state: runs.state })
            .from(runs)
            .where(eq(runs.threadId, threadId)),
        )
        expect(working).toEqual(
          expect.arrayContaining([
            { id: earlier, state: 'working' },
            { id: later, state: 'working' },
          ]),
        )
      }),
    )

    it.effect('refuses a response Run from another Thread even when its Person matches', () =>
      Effect.gen(function* () {
        const { database, person, threadId } = yield* fixture()
        const other = yield* fixture()
        yield* database.run(
          database.update(runs).set({ personId: person.id }).where(eq(runs.id, other.runId)),
        )
        yield* Ref.update(yield* Responses, (entries) =>
          entries.map((entry) =>
            entry.threadId === threadId ? { ...entry, runId: other.runId } : entry,
          ),
        )
        const store = yield* ArtifactStore
        const result = yield* store
          .write(person.id, threadId, {
            toolCallId: documentCall,
            title: 'Wrong Thread',
            body: 'Must not be saved.',
          })
          .pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure._tag).toBe('NotFound')
        expect(yield* store.list(person.id, threadId)).toEqual([])
        expect(yield* Ref.get(yield* Published)).not.toContain(Topic.thread(threadId))
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
              store.write(person.id, threadId, {
                toolCallId: documentCall,
                title: 'Plan',
                body: 'First',
              }),
              store.write(person.id, threadId, {
                toolCallId: documentCall,
                title: 'PLAN',
                body: 'Second',
              }),
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
          expect(ArtifactContent.guards.Document(detail.content)).toBe(true)
          if (!ArtifactContent.guards.Document(detail.content))
            return yield* Effect.die('Expected Markdown content')
          expect(detail.content.body).toBe(Result.isSuccess(firstOutcome) ? 'Person A' : 'Person B')
          expect(detail.shown.madeBy).toEqual(
            ArtifactAuthor.cases.Person.make({
              person: { id: person.id, name: person.name, image: null },
            }),
          )
          const body = detail.content.body
          yield* Effect.forEach(
            [1, 2, 3],
            () =>
              store.write(person.id, threadId, {
                toolCallId: documentCall,
                title: 'plan',
                body,
              }),
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
            toolCallId: documentCall,
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
          yield* store.write(person.id, threadId, {
            toolCallId: documentCall,
            title: 'Remove me',
            body: 'First',
          })
          const [first] = yield* store.list(person.id, threadId)
          if (first === undefined) return yield* Effect.die('Document missing')
          yield* store.remove(person.id, first.id)
          yield* store.write(person.id, threadId, {
            toolCallId: documentCall,
            title: 'Cascaded',
            body: 'First',
          })
          yield* store.write(person.id, threadId, {
            toolCallId: documentCall,
            title: 'Cascaded',
            body: 'Second',
          })
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
