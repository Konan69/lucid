import { unbound } from './action.ts'
import { scopedCase } from '../../tests/case.ts'
import * as NodeCrypto from 'node:crypto'
import * as Schema from 'effect/Schema'
import { RunId } from '@vivid/contracts'
import * as Logger from 'effect/Logger'
import { Message } from '../observability/messages.ts'
import { runs } from '../threads/tables.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import * as TestClock from 'effect/testing/TestClock'
import {
  ApprovalDecided,
  ApprovalDecision,
  ApprovalExpired,
  ApprovalState,
  AuditEvent,
  ActionTarget,
  BrowseTarget,
  BrowserAction,
  DesktopAction,
  Conflict,
  DatabaseFailure,
  NotFound,
  InvalidRequest,
  ProposedAction,
  RuleScope,
  RuntimeUnavailable,
} from '@vivid/contracts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { loadAudit } from '../audit/store.ts'
import { RuleStore } from '../rules/store.ts'
import { membershipTable } from '../companies/tables.ts'
import { threads } from '../threads/tables.ts'
import { ActionOutcome } from './gate.ts'
import { ApprovalStore } from './store.ts'
import { approvals } from './tables.ts'
import { desktopAction, fixture, Observation, trustTestServices } from './testing.ts'

const once = ApprovalDecision.cases.AllowOnce.make({})
/** A click on the Person's own signed-in page. */
const browserWrite = ProposedAction.make({
  summary: 'Click Send',
  rationale: '',
  effect: 'write',
  target: ActionTarget.cases.Browser.make({
    target: BrowseTarget.cases.Person.make({}),
    action: BrowserAction.cases.Click.make({ target: 'Send' }),
  }),
})

const always = ApprovalDecision.cases.AlwaysAllow.make({})

/** A1-A3 use addressed owner-role cards and real rows; reach loss must never settle pending work. */
/** Share only PostgreSQL; each case builds its own recording ports and captured stores. */
layer(testDatabaseLayer, { excludeTestServices: true })((it) => {
  describe.skipIf(!testDatabaseConfigured)('Approval inbox Thread privacy', () => {
    it.effect(
      'A1 making a Company Thread private hides its addressed Approval even from an owner',
      () =>
        scopedCase(
          trustTestServices,
          Effect.gen(function* () {
            const test = yield* fixture()
            const elsewhere = yield* fixture()
            const database = yield* Database
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'company' })
                .where(eq(threads.id, test.companyId)),
            )
            const store = yield* ApprovalStore
            const approval = yield* store.raise(
              {
                ...test.owner,
                by: 'vivid',
                threadId: Option.some(test.companyId),
                helper: Option.none(),
              },
              test.connectionAction,
              test.bound,
            )
            expect(yield* store.inbox(test.owner)).toEqual([approval])
            expect(yield* store.inbox(test.other)).toEqual([])
            expect(yield* store.inbox(test.member)).toEqual([])
            expect(
              yield* store.inbox({ ...test.owner, workspace: elsewhere.owner.workspace }),
            ).toEqual([])
            const before = yield* database.run(
              database.select().from(approvals).where(eq(approvals.id, approval.id)),
            )
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'private' })
                .where(eq(threads.id, test.companyId)),
            )
            expect(yield* store.inbox(test.owner)).toEqual([])
            expect(
              yield* database.run(
                database.select().from(approvals).where(eq(approvals.id, approval.id)),
              ),
            ).toEqual(before)
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'company' })
                .where(eq(threads.id, test.companyId)),
            )
            expect(yield* store.inbox(test.owner)).toEqual([approval])
            expect(
              yield* database.run(
                database.select().from(approvals).where(eq(approvals.id, approval.id)),
              ),
            ).toEqual(before)
          }),
          'fresh',
        ),
    )

    it.effect('A3 Membership removal hides an Approval from the same stale Company Actor', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          yield* database.run(
            database
              .update(threads)
              .set({ audience: 'company' })
              .where(eq(threads.id, test.companyId)),
          )
          const store = yield* ApprovalStore
          const approval = yield* store.raise(
            {
              ...test.owner,
              by: 'vivid',
              threadId: Option.some(test.companyId),
              helper: Option.none(),
            },
            test.connectionAction,
            test.bound,
          )
          expect(yield* store.inbox(test.owner)).toEqual([approval])
          const before = yield* database.run(
            database.select().from(approvals).where(eq(approvals.id, approval.id)),
          )
          yield* database.run(
            database
              .delete(membershipTable)
              .where(eq(membershipTable.userId, test.owner.person.id)),
          )
          expect(yield* store.inbox(test.owner)).toEqual([])
          expect(
            yield* database.run(
              database.select().from(approvals).where(eq(approvals.id, approval.id)),
            ),
          ).toEqual(before)
        }),
        'fresh',
      ),
    )
  })

  /** All writes use production stores against the isolated database; disabled without its explicit URL. */
  describe.skipIf(!testDatabaseConfigured)('Approval claims and outcomes', () => {
    it.effect('a Desktop decision records capability metadata without private action input', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* ApprovalStore
          const action = ProposedAction.make({
            ...desktopAction,
            target: ActionTarget.cases.Desktop.make({
              action: DesktopAction.cases.Type.make({ text: 'Private content' }),
            }),
          })
          const approval = yield* store.raise(test.vivid, action, unbound)
          yield* store.decide(test.personal, {
            id: approval.id,
            digest: approval.digest,
            decision: ApprovalDecision.cases.Deny.make({}),
          })
          const audit = yield* loadAudit(test.personal)
          expect(audit.entries).toMatchObject([
            { event: AuditEvent.cases.ActionDenied.make({ service: 'Computer', tool: 'desktop' }) },
          ])
          expect(JSON.stringify(audit)).not.toContain('Private content')
        }),
        'fresh',
      ),
    )

    it.effect(
      'a notification answer decides by the notice’s Approval, and a second is told it was answered',
      () =>
        scopedCase(
          trustTestServices,
          Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* ApprovalStore
            const approval = yield* store.raise(test.vivid, desktopAction, unbound)
            // The notice names the Approval its push answers (`push/delivery.ts` reads it).
            const [notice] = yield* Ref.get((yield* Observation).notices)
            if (notice === undefined || notice.approvalId === null)
              expect.fail('Expected a notice that names its Approval')
            expect(notice.approvalId).toBe(approval.id)
            // Decline from the notification: DecideApproval by that id and the pushed digest.
            const declined = yield* store.decide(test.personal, {
              id: notice.approvalId,
              digest: approval.digest,
              decision: ApprovalDecision.cases.Deny.make({}),
            })
            expect(declined.state._tag).toBe('Denied')
            // Allow pressed afterwards, on another device's copy of the same push.
            const late = yield* store
              .decide(test.personal, {
                id: notice.approvalId,
                digest: approval.digest,
                decision: once,
              })
              .pipe(Effect.flip)
            expect(late).toEqual(new ApprovalDecided({ id: approval.id }))
            expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
          }),
          'fresh',
        ),
    )

    it.effect('two concurrent decisions execute once and the loser gets ApprovalDecided', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* ApprovalStore
          const approval = yield* store.raise(test.vivid, test.connectionAction, test.bound)
          const request = { id: approval.id, digest: approval.digest, decision: once }
          const results = yield* Effect.all(
            [
              Effect.result(store.decide(test.personal, request)),
              Effect.result(store.decide(test.personal, request)),
            ],
            { concurrency: 2 },
          )
          expect(results.filter(Result.isSuccess)).toHaveLength(1)
          const failures = results.filter(Result.isFailure)
          expect(failures.map((result) => result.failure)).toEqual([expect.any(ApprovalDecided)])
          const observed = yield* Observation
          expect(yield* Ref.get(observed.actions)).toEqual([test.connectionAction])
          const deliveries = yield* Ref.get(observed.deliveries)
          expect(deliveries).toHaveLength(1)
          expect(deliveries[0]).toMatchObject({
            idempotencyKey: `approval-${approval.id}`,
            personId: test.personal.person.id,
            message: { cue: { outcome: 'Succeeded' } },
          })
          expect((yield* loadAudit(test.personal)).entries).toEqual([
            expect.objectContaining({
              threadId: approval.threadId,
              by: 'person',
              event: AuditEvent.cases.ActionApproved.make({
                service: 'Work account',
                tool: 'update_project',
              }),
            }),
          ])
        }),
        'fresh',
      ),
    )

    it.effect(
      'an edited draft sends the Person’s words, and an edit beyond words runs nothing',
      () =>
        scopedCase(
          trustTestServices,
          Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* ApprovalStore
            const asked = {
              to: ['dami@example.com'],
              subject: 'The NDA',
              body: 'Signed.',
              copies: 1,
            }
            const send = ProposedAction.make({
              summary: 'Send the signed NDA to Dami',
              rationale: 'Dami asked for it',
              effect: 'write',
              target: ActionTarget.cases.Connection.make({
                connectionId: test.connectionId,
                account: 'Work account',
                tool: 'send_email',
                input: asked,
              }),
            })
            const approval = yield* store.raise(test.vivid, send, test.bound)
            const edit = (input: Schema.JsonObject) => ({
              id: approval.id,
              digest: approval.digest,
              decision: ApprovalDecision.cases.AllowEdited.make({ input }),
            })
            // A field Vivid did not write, and a number turned into words, are not a draft's words.
            for (const input of [
              { ...asked, bcc: 'someone@example.com' },
              { ...asked, copies: 'many' },
            ]) {
              const refused = yield* store.decide(test.personal, edit(input)).pipe(Effect.flip)
              expect(refused).toBeInstanceOf(InvalidRequest)
            }
            expect((yield* store.inbox(test.personal)).map((each) => each.id)).toEqual([
              approval.id,
            ])
            const observed = yield* Observation
            expect(yield* Ref.get(observed.actions)).toEqual([])

            const edited = {
              to: ['dami@example.com', 'legal@example.com'],
              subject: 'The signed NDA',
              body: 'Signed and attached.',
              copies: 1,
            }
            const sent = yield* store.decide(test.personal, edit(edited))
            expect(sent.state._tag).toBe('Succeeded')
            const asSent = ProposedAction.make({
              ...send,
              target: ActionTarget.cases.Connection.make({
                connectionId: test.connectionId,
                account: 'Work account',
                tool: 'send_email',
                input: edited,
              }),
            })
            expect(yield* Ref.get(observed.actions)).toEqual([asSent])
            // The record says what was sent, and the item has left the Person's inbox.
            expect(sent.action).toEqual(asSent)
            expect(sent.digest).toBe(approval.digest)
            expect(yield* store.inbox(test.personal)).toEqual([])
          }),
          'fresh',
        ),
    )

    it.effect('a changed digest fails without executing', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* ApprovalStore
          const approval = yield* store.raise(test.vivid, test.connectionAction, test.bound)
          const result = yield* Effect.result(
            store.decide(test.personal, { id: approval.id, digest: 'wrong', decision: once }),
          )
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(Conflict)
          expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
        }),
        'fresh',
      ),
    )

    it.effect(
      'an expired Approval cannot be decided and the sweeper publishes its settled state',
      () =>
        scopedCase(
          trustTestServices,
          Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* ApprovalStore
            const approval = yield* store.raise(test.vivid, test.connectionAction, test.bound)
            const database = yield* Database
            yield* database.run(
              database
                .update(approvals)
                .set({ expiresAt: yield* Clock.currentTimeMillis })
                .where(eq(approvals.id, approval.id)),
            )
            const result = yield* Effect.result(
              store.decide(test.personal, {
                id: approval.id,
                digest: approval.digest,
                decision: once,
              }),
            )
            if (Result.isFailure(result))
              expect(result.failure).toEqual(new ApprovalExpired({ id: approval.id }))
            expect(Result.isFailure(result)).toBe(true)
            yield* store.expire
            const records = yield* store.inThread(test.personalId)
            const expired = records[0]
            expect(expired).toBeDefined()
            if (expired !== undefined)
              expect(ApprovalState.guards.Expired(expired.state)).toBe(true)
            expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
            expect(yield* Ref.get((yield* Observation).topics)).toContain(`t:${test.personalId}`)
            expect(yield* Ref.get((yield* Observation).deliveries)).toEqual([
              expect.objectContaining({
                threadId: approval.threadId,
                personId: test.personal.person.id,
                idempotencyKey: `approval-${approval.id}`,
                message: expect.objectContaining({
                  cue: expect.objectContaining({ outcome: 'expired' }),
                }),
              }),
            ])
            yield* store.expire
            expect(yield* Ref.get((yield* Observation).deliveries)).toHaveLength(1)
          }),
          'fresh',
        ),
    )

    it.effect('another Person including the Company owner gets NotFound', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* ApprovalStore
          const approval = yield* store.raise(test.companyVivid, test.connectionAction, test.bound)
          const result = yield* Effect.result(
            store.decide(test.owner, { id: approval.id, digest: approval.digest, decision: once }),
          )
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(NotFound)
          expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
          expect(yield* store.inbox(test.owner)).toEqual([])
        }),
        'fresh',
      ),
    )

    it.effect('Unknown is stored and a later decision never runs the action again', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* ApprovalStore
          const observed = yield* Observation
          yield* Ref.set(observed.outcome, ActionOutcome.cases.Unknown.make({}))
          const approval = yield* store.raise(test.vivid, test.connectionAction, test.bound)
          const request = { id: approval.id, digest: approval.digest, decision: once }
          const settled = yield* store.decide(test.personal, request)
          expect(ApprovalState.guards.OutcomeUnknown(settled.state)).toBe(true)
          const again = yield* Effect.result(store.decide(test.personal, request))
          expect(Result.isFailure(again)).toBe(true)
          expect(yield* Ref.get(observed.actions)).toEqual([test.connectionAction])
          const audit = yield* loadAudit(test.personal)
          expect(audit.entries).toEqual([
            expect.objectContaining({
              threadId: approval.threadId,
              event: AuditEvent.cases.ActionOutcomeUnknown.make({
                service: 'Work account',
                tool: 'update_project',
              }),
            }),
          ])
        }),
        'fresh',
      ),
    )

    it.effect(
      'AlwaysAllow writes personal policy, executes stored input, and settles despite delivery failure',
      () =>
        scopedCase(
          trustTestServices,
          Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* ApprovalStore
            const observed = yield* Observation
            yield* Ref.set(
              observed.deliveryFailure,
              Option.some(new RuntimeUnavailable({ message: 'Unavailable' })),
            )
            const approval = yield* store.raise(
              test.companyVivid,
              test.connectionAction,
              test.bound,
            )
            const settled = yield* store.decide(test.member, {
              id: approval.id,
              digest: approval.digest,
              decision: ApprovalDecision.cases.AlwaysAllow.make({}),
            })
            expect(ApprovalState.guards.Succeeded(settled.state)).toBe(true)
            expect(yield* Ref.get(observed.actions)).toEqual([test.connectionAction])
            const rules = yield* (yield* RuleStore).list(test.personal)
            expect(rules).toHaveLength(1)
            expect(rules[0]).toMatchObject({
              action: test.connectionAction.summary,
              decision: 'Allow',
              scope: RuleScope.cases.Personal.make({}),
            })
          }),
          'fresh',
        ),
    )

    it.effect('simultaneous identical proposals share one pending Approval and notification', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* ApprovalStore
          const results = yield* Effect.all(
            [
              store.raise(test.vivid, test.connectionAction, test.bound),
              store.raise(test.vivid, test.connectionAction, test.bound),
            ],
            { concurrency: 2 },
          )
          expect(results[0]).toEqual(results[1])
          expect(yield* store.inThread(test.personalId)).toHaveLength(1)
          expect(yield* Ref.get((yield* Observation).notices)).toHaveLength(1)
        }),
        'fresh',
      ),
    )

    it.effect('denial and withdrawal leave actions untouched and preserve the terminal cards', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* ApprovalStore
          const denied = yield* store.raise(test.vivid, test.connectionAction, test.bound)
          const lines: string[] = []
          const logger = Logger.make((entry) => lines.push(Logger.formatSimple.log(entry)))
          const loggers = new Set([...(yield* Logger.CurrentLoggers), logger])
          const request = {
            id: denied.id,
            digest: denied.digest,
            decision: ApprovalDecision.cases.Deny.make({}),
          }
          const settled = yield* store
            .decide(test.personal, request)
            .pipe(Effect.provideService(Logger.CurrentLoggers, loggers))
          // Replayed decisions fail the SQL claim; reading the terminal card decides nothing new.
          expect(
            (yield* store
              .decide(test.personal, request)
              .pipe(Effect.flip, Effect.provideService(Logger.CurrentLoggers, loggers)))._tag,
          ).toBe('ApprovalDecided')
          yield* store
            .inThread(test.personalId)
            .pipe(Effect.provideService(Logger.CurrentLoggers, loggers))
          const recorded = lines.filter((line) => line.includes(Message.refusal))
          expect(recorded).toHaveLength(1)
          expect(recorded[0]).toContain('vivid.refusal.kind=ApprovalDenied')
          expect(recorded[0]).toContain('vivid.refusal.effect=write')
          expect(recorded[0]).toContain('vivid.refusal.target=Connection')
          expect(ApprovalState.guards.Denied(settled.state)).toBe(true)
          expect((yield* loadAudit(test.personal)).entries).toEqual([
            expect.objectContaining({
              threadId: denied.threadId,
              event: AuditEvent.cases.ActionDenied.make({
                service: 'Work account',
                tool: 'update_project',
              }),
            }),
          ])
          const withdrawn = yield* store.raise(test.vivid, test.connectionAction, test.bound)
          yield* store.withdraw(test.personal, withdrawn.id)
          const records = yield* store.inThread(test.personalId)
          expect(records.map((row) => row.state._tag)).toEqual(
            expect.arrayContaining(['Denied', 'Withdrawn']),
          )
          expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
        }),
        'fresh',
      ),
    )

    it.effect('inconsistent stored columns fail as DatabaseFailure', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* ApprovalStore
          const approval = yield* store.raise(test.vivid, test.connectionAction, test.bound)
          const database = yield* Database
          yield* database.run(
            database
              .update(approvals)
              .set({ status: 'succeeded' })
              .where(eq(approvals.id, approval.id)),
          )
          const result = yield* Effect.result(store.inThread(test.personalId))
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(DatabaseFailure)
        }),
        'fresh',
      ),
    )
  })

  /** Recovery shares this sequential suite with claims so a global sweep cannot steal an in-flight fixture. */
  describe.skipIf(!testDatabaseConfigured)('Approval recovery and permanent permission', () => {
    it.effect(
      'abandoned executions settle unknown after ten minutes, signal once, and never retry',
      () =>
        scopedCase(
          trustTestServices,
          Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* ApprovalStore
            const observed = yield* Observation
            const approval = yield* store.raise(
              test.companyVivid,
              test.connectionAction,
              test.bound,
            )
            const request = { id: approval.id, digest: approval.digest, decision: once }
            yield* Ref.set(observed.runnerDefect, true)
            expect(Exit.isFailure(yield* Effect.exit(store.decide(test.member, request)))).toBe(
              true,
            )
            const started = yield* Clock.currentTimeMillis
            yield* TestClock.setTime(started + 10 * 60 * 1000)
            yield* store.expire
            expect((yield* store.inThread(test.companyId)).map((row) => row.state._tag)).toEqual([
              'Executing',
            ])
            expect(yield* Ref.get(observed.deliveries)).toEqual([])
            yield* TestClock.setTime(started + 10 * 60 * 1000 + 1)
            yield* Effect.all([store.expire, store.expire], { concurrency: 2 })
            const records = yield* store.inThread(test.companyId)
            expect(records.map((row) => row.state._tag)).toEqual(['OutcomeUnknown'])
            expect(yield* Ref.get(observed.actions)).toEqual([test.connectionAction])
            expect(yield* Ref.get(observed.deliveries)).toEqual([
              expect.objectContaining({
                threadId: approval.threadId,
                personId: test.member.person.id,
                idempotencyKey: `approval-${approval.id}`,
                message: expect.objectContaining({
                  cue: expect.objectContaining({ outcome: 'OutcomeUnknown' }),
                }),
              }),
            ])
            expect((yield* loadAudit(test.owner)).entries).toEqual([
              expect.objectContaining({
                threadId: approval.threadId,
                by: 'person',
                actor: test.summary,
                event: AuditEvent.cases.ActionOutcomeUnknown.make({
                  service: 'Work account',
                  tool: 'update_project',
                }),
              }),
            ])
            expect((yield* Ref.get(observed.topics)).some((topic) => topic.startsWith('c:'))).toBe(
              true,
            )
            yield* Ref.set(observed.runnerDefect, false)
            const again = yield* Effect.result(store.decide(test.member, request))
            expect(Result.isFailure(again)).toBe(true)
            if (Result.isFailure(again)) expect(again.failure).toBeInstanceOf(ApprovalDecided)
            yield* store.expire
            expect(yield* Ref.get(observed.actions)).toHaveLength(1)
            expect(yield* Ref.get(observed.deliveries)).toHaveLength(1)
          }),
          'fresh',
        ),
    )

    it.effect('an approved action that fails records ActionFailed with its stored Thread', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* ApprovalStore
          const observed = yield* Observation
          yield* Ref.set(
            observed.outcome,
            ActionOutcome.cases.Failed.make({ reason: 'Computer refused the command' }),
          )
          const approval = yield* store.raise(test.vivid, desktopAction, unbound)
          const settled = yield* store.decide(test.personal, {
            id: approval.id,
            digest: approval.digest,
            decision: once,
          })
          expect(ApprovalState.guards.Failed(settled.state)).toBe(true)
          expect((yield* loadAudit(test.personal)).entries).toEqual([
            expect.objectContaining({
              threadId: approval.threadId,
              by: 'person',
              event: AuditEvent.cases.ActionFailed.make({ service: 'Computer', tool: 'desktop' }),
            }),
          ])
          expect(yield* Ref.get(observed.deliveries)).toEqual([
            expect.objectContaining({
              message: expect.objectContaining({
                cue: expect.objectContaining({ outcome: 'Failed' }),
              }),
            }),
          ])
        }),
        'fresh',
      ),
    )

    it.effect('AlwaysAllow refuses destructive work before claiming or inserting a rule', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const store = yield* ApprovalStore
          const action = ProposedAction.make({ ...desktopAction, effect: 'destructive' })
          const approval = yield* store.raise(test.vivid, action, unbound)
          const result = yield* Effect.result(
            store.decide(test.personal, {
              id: approval.id,
              digest: approval.digest,
              decision: always,
            }),
          )
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(InvalidRequest)
            expect(result.failure.message).toBe('This kind of action is always asked about')
          }
          expect((yield* store.inThread(test.personalId)).map((row) => row.state._tag)).toEqual([
            'Pending',
          ])
          expect(yield* (yield* RuleStore).list(test.personal)).toEqual([])
          expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
          expect((yield* loadAudit(test.personal)).entries).toEqual([])
          const settled = yield* store.decide(test.personal, {
            id: approval.id,
            digest: approval.digest,
            decision: once,
          })
          expect(ApprovalState.guards.Succeeded(settled.state)).toBe(true)
        }),
        'fresh',
      ),
    )

    it.effect(
      'AlwaysAllow refuses personal Connection exposure in a shared Thread before claiming',
      () =>
        scopedCase(
          trustTestServices,
          Effect.gen(function* () {
            const test = yield* fixture()
            const database = yield* Database
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'company' })
                .where(eq(threads.id, test.companyId)),
            )
            const store = yield* ApprovalStore
            const action = ProposedAction.make({ ...test.connectionAction, effect: 'read' })
            const approval = yield* store.raise(test.companyVivid, action, unbound)
            const result = yield* Effect.result(
              store.decide(test.member, {
                id: approval.id,
                digest: approval.digest,
                decision: always,
              }),
            )
            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(InvalidRequest)
              expect(result.failure.message).toBe('This kind of action is always asked about')
            }
            expect((yield* store.inThread(test.companyId)).map((row) => row.state._tag)).toEqual([
              'Pending',
            ])
            expect(yield* (yield* RuleStore).list(test.personal)).toEqual([])
            expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
            expect((yield* loadAudit(test.owner)).entries).toEqual([])
          }),
          'fresh',
        ),
    )

    // Owner decision, 4 October 2026: a write on the Person's own browser follows the same table
    // as a write through their own Integration, and that includes "Always allow".
    it.effect(
      'AlwaysAllow on the Person’s own browser writes the rule in a private Thread and runs the action',
      () =>
        scopedCase(
          trustTestServices,
          Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* ApprovalStore
            const approval = yield* store.raise(test.vivid, browserWrite, unbound)
            const settled = yield* store.decide(test.personal, {
              id: approval.id,
              digest: approval.digest,
              decision: always,
            })
            expect(ApprovalState.guards.Succeeded(settled.state)).toBe(true)
            expect(
              (yield* (yield* RuleStore).list(test.personal)).map((rule) => rule.decision),
            ).toEqual(['Allow'])
            expect(yield* Ref.get((yield* Observation).actions)).toEqual([browserWrite])
          }),
          'fresh',
        ),
    )

    it.effect(
      'AlwaysAllow on the Person’s own browser is refused in a Thread others can see, before claiming',
      () =>
        scopedCase(
          trustTestServices,
          Effect.gen(function* () {
            const test = yield* fixture()
            const database = yield* Database
            yield* database.run(
              database
                .update(threads)
                .set({ audience: 'company' })
                .where(eq(threads.id, test.companyId)),
            )
            const store = yield* ApprovalStore
            const approval = yield* store.raise(test.companyVivid, browserWrite, unbound)
            const result = yield* Effect.result(
              store.decide(test.member, {
                id: approval.id,
                digest: approval.digest,
                decision: always,
              }),
            )
            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(InvalidRequest)
              expect(result.failure.message).toBe('This kind of action is always asked about')
            }
            expect((yield* store.inThread(test.companyId)).map((row) => row.state._tag)).toEqual([
              'Pending',
            ])
            expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
            expect(yield* (yield* RuleStore).list(test.personal)).toEqual([])
            expect((yield* loadAudit(test.owner)).entries).toEqual([])
          }),
          'fresh',
        ),
    )
  })

  /** Separate turns proposing the same capability share the first pending card and execute once. */
  describe.skipIf(!testDatabaseConfigured)('Approval identity across Runs', () => {
    it.effect('keeps the first origin and returns one pending Approval to both Runs', () =>
      scopedCase(
        trustTestServices,
        Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          const store = yield* ApprovalStore
          const first = RunId.make(NodeCrypto.randomUUID())
          const second = RunId.make(NodeCrypto.randomUUID())
          const origin = encodeCrossRunOrigin(StoredRunOrigin.cases.Message.make({}))
          yield* database.run(
            database.insert(runs).values({
              id: first,
              threadId: test.personalId,
              personId: test.personal.person.id,
              turn: 1,
              state: 'working',
              origin,
              startedAt: 0,
              admittedAt: 0,
            }),
          )
          const initial = yield* store.raise(test.vivid, desktopAction, unbound)
          yield* database.run(
            database
              .update(runs)
              .set({ state: 'completed', finishedAt: 1 })
              .where(eq(runs.id, first)),
          )
          yield* database.run(
            database.insert(runs).values({
              id: second,
              threadId: test.personalId,
              personId: test.personal.person.id,
              turn: 2,
              state: 'working',
              origin,
              startedAt: 1,
              admittedAt: 1,
            }),
          )
          const repeated = yield* store.raise(test.vivid, desktopAction, unbound)
          expect(repeated.id).toBe(initial.id)
          expect(repeated.runId).toBe(first)
          expect(yield* store.inThread(test.personalId)).toHaveLength(1)
          const request = { id: initial.id, digest: initial.digest, decision: once }
          expect((yield* store.decide(test.personal, request)).state._tag).toBe('Succeeded')
          expect((yield* store.decide(test.personal, request).pipe(Effect.flip))._tag).toBe(
            'ApprovalDecided',
          )
          expect(yield* Ref.get((yield* Observation).actions)).toEqual([desktopAction])
        }),
        'fresh',
      ),
    )
  })

  const encodeCrossRunOrigin = Schema.encodeSync(StoredRunOrigin)
})
