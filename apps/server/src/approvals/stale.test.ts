import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import {
  ActionTarget,
  ApprovalBinding,
  ApprovalPrecondition,
  ArtifactAuthor,
  ApprovalChanged,
  ApprovalDecision,
  ApprovalInvalidation,
  ApprovalState,
  ArtifactId,
  ConnectionState,
  ProposedAction,
  SignalCue,
  type Approval,
  type ApprovalId,
  type ThreadId,
} from '@vivid/contracts'
import { scopedCase } from '../../tests/case.ts'
import {
  artifactStoreLayer,
  ArtifactStore,
  bindDocuments,
  DocumentNotFound,
} from '../artifacts/store.ts'
import { contentDigest } from './action.ts'
import { artifacts, artifactVersions } from '../artifacts/tables.ts'
import { decodeRow, grantOf, saveState } from '../connections/records.ts'
import { connections } from '../connections/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { Runtime } from '../runtime/client.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { stopPersonRun } from '../threads/stop.ts'
import { Signal } from './signal.ts'
import { ApprovalStore } from './store.ts'
import { approvals } from './tables.ts'
import { fixture, Observation, recordRuns, testRunId, trustTestServices } from './testing.ts'

const once = ApprovalDecision.cases.AllowOnce.make({})
const decodeSignal = Schema.decodeUnknownEffect(Signal)
const encodeAuthor = Schema.encodeSync(ArtifactAuthor)

/** Stopping a Run reaches the runtime; nothing here has one, so the stop is acknowledged. */
const runtime = Layer.succeed(
  Runtime,
  Runtime.of({
    admit: () => Effect.die('Stale approval tests do not admit deliveries'),
    settled: () => Effect.never,
    stop: () => Effect.succeed(true),
    watch: () => Stream.never,
    read: () => Effect.die('Stale approval tests do not read history'),
  }),
)
const services = artifactStoreLayer.pipe(
  Layer.provideMerge(Layer.merge(trustTestServices, runtime)),
)

/** A document in the Thread, as `write_document` leaves one at version 1. */
const document = Effect.fn('StaleTest.document')(function* (
  threadId: ThreadId,
  title: string,
  body: string,
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const id = ArtifactId.make(NodeCrypto.randomUUID())
  yield* database.run(
    database.insert(artifacts).values({
      id,
      threadId,
      kind: 'document',
      title,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* database.run(
    database.insert(artifactVersions).values({
      artifactId: id,
      number: 1,
      body,
      note: null,
      madeBy: encodeAuthor(
        ArtifactAuthor.cases.Vivid.make({ runId: testRunId(threadId, 'writer') }),
      ),
      at: now,
    }),
  )
  return id
})

/** Asks to send a document through the fixture's Integration, as `use_tool` prepares it. */
const askToSend = Effect.fn('StaleTest.askToSend')(function* (
  test: Effect.Success<ReturnType<typeof fixture>>,
  title: string,
) {
  const bound = yield* bindDocuments(test.personal.person.id, test.personalId, {
    to: 'dami@example.test',
    body: { $document: title },
  })
  const action = ProposedAction.make({
    ...test.connectionAction,
    summary: `Send ${title} to Dami`,
    target: ActionTarget.cases.Connection.make({
      connectionId: test.connectionId,
      account: 'Work account',
      tool: 'send_email',
      input: bound.input,
    }),
  })
  return yield* (yield* ApprovalStore).raise(
    test.vivid,
    action,
    ApprovalBinding.make({ connectionGeneration: 0, preconditions: bound.preconditions }),
  )
})

/** The Approval as the Thread reads it now. */
const current = Effect.fn('StaleTest.current')(function* (approval: Approval) {
  const all = yield* (yield* ApprovalStore).inThread(approval.threadId)
  const found = all.find((candidate) => candidate.id === approval.id)
  if (found === undefined) return yield* Effect.die('The Approval left its Thread')
  return found
})

/** What the row owes Vivid. */
const signalOf = Effect.fn('StaleTest.signalOf')(function* (id: ApprovalId) {
  const database = yield* Database
  const [row] = yield* database.run(
    database.select({ signal: approvals.signal }).from(approvals).where(eq(approvals.id, id)),
  )
  if (row === undefined) return yield* Effect.die('The Approval row is missing')
  return yield* decodeSignal(row.signal)
})

/** Why the Approval is invalidated; any other state fails the case. */
const reasonOf = (approval: Approval) => {
  if (!ApprovalState.guards.Invalidated(approval.state))
    throw new Error(`Expected an invalidated Approval, found ${approval.state._tag}`)
  return approval.state.reason
}

const allow = (test: Effect.Success<ReturnType<typeof fixture>>, approval: Approval) =>
  Effect.flatMap(ApprovalStore, (store) =>
    store.decide(test.personal, { id: approval.id, digest: approval.digest, decision: once }),
  )

layer(testDatabaseLayer, { excludeTestServices: true })((it) => {
  describe.skipIf(!testDatabaseConfigured)(
    'An Approval goes stale when what it approved changes',
    () => {
      it.effect('S1 revising the document closes the ask, refuses Allow and wakes Vivid', () =>
        scopedCase(
          services,
          Effect.gen(function* () {
            const test = yield* fixture()
            const letter = yield* document(test.personalId, 'Letter to Dami', 'Dear Dami, v1')
            // Titles resolve the way the Thread's unique index compares them: case-blind.
            const approval = yield* askToSend(test, 'letter to dami')
            expect(approval.action.target).toMatchObject({ input: { body: 'Dear Dami, v1' } })
            expect(approval.binding).toEqual(
              ApprovalBinding.make({
                connectionGeneration: 0,
                preconditions: [
                  ApprovalPrecondition.cases.ArtifactVersion.make({
                    artifactId: letter,
                    version: 1,
                    contentDigest: contentDigest('Dear Dami, v1'),
                  }),
                ],
              }),
            )
            yield* (yield* ArtifactStore).revise(test.personal.person, {
              id: letter,
              from: 1,
              body: 'Dear Dami, v2',
            })
            const after = yield* current(approval)
            expect(ApprovalState.guards.Invalidated(after.state)).toBe(true)
            expect(reasonOf(after)).toEqual(
              ApprovalInvalidation.cases.ContentChanged.make({ artifactId: letter, version: 2 }),
            )
            const refused = yield* Effect.flip(allow(test, approval))
            expect(refused).toEqual(new ApprovalChanged({ id: approval.id }))
            expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
            const signal = yield* signalOf(approval.id)
            expect(Signal.guards.Owed(signal)).toBe(true)
            if (!Signal.guards.Owed(signal) || !SignalCue.guards.Approval(signal.message.cue))
              expect.fail('Expected an owed Approval signal')
            expect(signal.message.cue.body).toContain('went stale')
            // The fresh ask, prepared again from the revised document, is a new Approval.
            const fresh = yield* askToSend(test, 'Letter to Dami')
            expect(fresh.id).not.toEqual(approval.id)
            expect(fresh.action.target).toMatchObject({ input: { body: 'Dear Dami, v2' } })
            expect(ApprovalState.guards.Pending(fresh.state)).toBe(true)
          }),
          'fresh',
        ),
      )

      it.effect('S2 a title the Thread does not have is refused with the titles it does have', () =>
        scopedCase(
          services,
          Effect.gen(function* () {
            const test = yield* fixture()
            yield* document(test.personalId, 'Letter to Dami', 'Dear Dami')
            const refused = yield* Effect.flip(
              bindDocuments(test.personal.person.id, test.personalId, {
                body: { $document: 'Memo' },
              }),
            )
            expect(refused).toEqual(
              new DocumentNotFound({ title: 'Memo', titles: ['Letter to Dami'] }),
            )
            // Only the exact one-key shape is a reference; anything beside it is ordinary input.
            const untouched = { body: { $document: 'Memo', note: 'kept' } }
            expect(
              (yield* bindDocuments(test.personal.person.id, test.personalId, untouched)).input,
            ).toEqual(untouched)
          }),
          'fresh',
        ),
      )

      it.effect('S3 stopping the Run that asked closes its ask without waking Vivid', () =>
        scopedCase(
          services,
          Effect.gen(function* () {
            const test = yield* fixture()
            const person = test.personal.person.id
            yield* recordRuns(test.personalId, [
              {
                id: 'asking',
                personId: person,
                origin: StoredRunOrigin.cases.Message.make({}),
                working: true,
              },
            ])
            const runId = testRunId(test.personalId, 'asking')
            const approval = yield* (yield* ApprovalStore).raise(
              test.vivid,
              test.connectionAction,
              test.bound,
            )
            expect(approval.runId).toEqual(runId)
            yield* stopPersonRun(person, runId)
            const after = yield* current(approval)
            expect(reasonOf(after)).toEqual(ApprovalInvalidation.cases.RunStopped.make({ runId }))
            expect(Signal.guards.None(yield* signalOf(approval.id))).toBe(true)
            expect(yield* Effect.flip(allow(test, approval))).toEqual(
              new ApprovalChanged({ id: approval.id }),
            )
          }),
          'fresh',
        ),
      )

      it.effect('S4 signing the Integration in again closes the ask and refuses Allow', () =>
        scopedCase(
          services,
          Effect.gen(function* () {
            const test = yield* fixture()
            const database = yield* Database
            const approval = yield* (yield* ApprovalStore).raise(
              test.vivid,
              test.connectionAction,
              test.bound,
            )
            const [stored] = yield* database.run(
              database.select().from(connections).where(eq(connections.id, test.connectionId)),
            )
            if (stored === undefined) return yield* Effect.die('The fixture Integration is missing')
            const row = yield* decodeRow(stored)
            const saved = yield* saveState(
              row,
              ConnectionState.cases.Ready.make({}),
              row.references,
              grantOf(row),
            )
            expect(saved.authorizationGeneration).toBe(1)
            const after = yield* current(approval)
            expect(reasonOf(after)).toEqual(
              ApprovalInvalidation.cases.ConnectionChanged.make({
                connectionId: test.connectionId,
                generation: 1,
              }),
            )
            expect(yield* Effect.flip(allow(test, approval))).toEqual(
              new ApprovalChanged({ id: approval.id }),
            )
            expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
            expect(Signal.guards.Owed(yield* signalOf(approval.id))).toBe(true)
          }),
          'fresh',
        ),
      )

      it.effect('S5 the claim checks the binding itself, whoever changed the Integration', () =>
        scopedCase(
          services,
          Effect.gen(function* () {
            const test = yield* fixture()
            const database = yield* Database
            const approval = yield* (yield* ApprovalStore).raise(
              test.vivid,
              test.connectionAction,
              test.bound,
            )
            // A change the claim must catch without help: an Approval raised against a generation
            // that moved before it committed is never reached by the mover's own invalidation.
            yield* database.run(
              database
                .update(connections)
                .set({ authorizationGeneration: 7 })
                .where(eq(connections.id, test.connectionId)),
            )
            expect(ApprovalState.guards.Pending((yield* current(approval)).state)).toBe(true)
            expect(yield* Effect.flip(allow(test, approval))).toEqual(
              new ApprovalChanged({ id: approval.id }),
            )
            expect(reasonOf(yield* current(approval))).toEqual(
              ApprovalInvalidation.cases.ConnectionChanged.make({
                connectionId: test.connectionId,
                generation: 7,
              }),
            )
            expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
          }),
          'fresh',
        ),
      )

      it.effect('S6 an edit and an Allow racing on one Approval leave exactly one outcome', () =>
        scopedCase(
          services,
          Effect.gen(function* () {
            const test = yield* fixture()
            const observed = yield* Observation
            const letter = yield* document(test.personalId, 'Letter', 'Draft 1')
            const endings = { ran: 0, changed: 0 }
            for (let round = 1; round <= 8; round += 1) {
              const approval = yield* askToSend(test, 'Letter')
              const before = (yield* Ref.get(observed.actions)).length
              const [decided] = yield* Effect.all(
                [
                  Effect.result(allow(test, approval)),
                  (yield* ArtifactStore).revise(test.personal.person, {
                    id: letter,
                    from: round,
                    body: `Draft ${round + 1}`,
                  }),
                ],
                { concurrency: 'unbounded' },
              )
              const after = yield* current(approval)
              const ran = (yield* Ref.get(observed.actions)).length - before
              if (Result.isSuccess(decided)) {
                // Allow won: the approved text ran once, and the edit found nothing pending to close.
                expect(ApprovalState.guards.Succeeded(after.state)).toBe(true)
                expect(ran).toBe(1)
                endings.ran += 1
              } else {
                // The edit won: nothing ran, and the Approval says what changed.
                expect(decided.failure).toEqual(new ApprovalChanged({ id: approval.id }))
                expect(ApprovalState.guards.Invalidated(after.state)).toBe(true)
                expect(ran).toBe(0)
                endings.changed += 1
              }
            }
            expect(endings.ran + endings.changed).toBe(8)
          }),
          'fresh',
        ),
      )
    },
  )
})
