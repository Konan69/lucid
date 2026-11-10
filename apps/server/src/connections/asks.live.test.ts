import { inputRequests } from '../inputs/tables.ts'
import { actionRunnerLayer } from '../approvals/runner.ts'
import { DeviceRegistry } from '../computers/device.ts'
import { ComputerStore } from '../computers/store.ts'
import { Watches } from '../watches/lifecycle.ts'
import * as NodeProcess from 'node:process'
import * as NodeChildProcess from 'node:child_process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import {
  ActionTarget,
  ApprovalBinding,
  ApprovalState,
  ProposedAction,
  ActionReceipt,
  InputRequestState,
  ToolCallId,
  ApprovalDecision,
  IntegrationAnswerOutcome,
  ToolOutcome,
  DisplayCallPolicy,
} from '@vivid/contracts'
import {
  Clock,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
} from 'effect'
import { HttpClient } from 'effect/http'
import { eq } from 'drizzle-orm'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { actions } from '../actions/tables.ts'
import { claim, operationOf } from '../actions/journal.ts'
import { ApprovalStore, approvalStoreLayer } from '../approvals/store.ts'
import { InputStore } from '../inputs/store.ts'
import { trustTestLayer, fixture } from '../approvals/testing.ts'
import { connectionTestLayer } from './testing.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { ExecutorCallOutcome, executorLayer } from './executor.ts'
import { executorMembersLayer, operationsOf } from './members.ts'
import { integrationAnswersLayer } from './asks.ts'
import { runConnection, useTool, useQueryTool } from './tools.ts'

const decodeReceipt = Schema.decodeUnknownEffect(ActionReceipt)
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ params: Schema.Struct({ name: Schema.String }) })),
)

const enabled = NodeProcess.env['VIVID_LIVE_INTEGRATION_ASKS'] === '1'
const settings = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    GOOGLE_CLIENT_ID: 'isolated-test-client',
    GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
    VIVID_EXECUTOR_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
    VIVID_EXECUTOR_PUBLIC_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
    VIVID_EXECUTOR_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_KEY'],
    VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
    VIVID_EXECUTOR_OWNER_EMAIL: NodeProcess.env['VIVID_TEST_EXECUTOR_OWNER_EMAIL'],
    VIVID_EXECUTOR_OWNER_PASSWORD: NodeProcess.env['VIVID_TEST_EXECUTOR_OWNER_PASSWORD'],
    VIVID_EXECUTOR_SEAL_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_SEAL_KEY'],
  }),
)

const app = {
  name: 'Integration question proof',
  files: [
    {
      path: 'migrations/0001_effects.sql',
      content: 'CREATE TABLE effects (marker TEXT PRIMARY KEY, phase TEXT NOT NULL);',
    },
    {
      path: 'index.ts',
      content: `import { defineApp, query, mutation, object, string, router } from 'apps';
import { always } from 'apps/operations/approval';
const input = object({ marker: string() });
export default defineApp({}, { tools: router({
  approve: mutation({ input, description: 'Record one approved effect', approval: always() }, async (ctx, {marker}) => {
    ctx.sql.exec('INSERT INTO effects VALUES (?, ?)', marker, 'approved');
    return {marker};
  }),
  input: mutation({ input, description: 'Ask for typed values after acting' }, async (ctx, {marker}) => {
    ctx.sql.exec('INSERT INTO effects VALUES (?, ?)', marker, 'before-input');
    const answer = await ctx.elicit({mode:'form', message:'Name and configure this result', requestedSchema:{
      type:'object', properties:{name:{type:'string',description:'Result name'},count:{type:'integer'},enabled:{type:'boolean'},color:{type:'string',enum:['red','blue']},note:{type:'string'}}, required:['name','count','enabled','color']
    }});
    ctx.sql.exec('UPDATE effects SET phase = ? WHERE marker = ?', JSON.stringify(answer), marker);
    return answer;
  }),
  question: query({input,description:'Ask without a write'}, async (ctx) => ctx.elicit({mode:'form',message:'Name the read',requestedSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}})),
  inspect: query({input,description:'Read the proof effect'}, async (ctx, {marker}) => ctx.sql.exec('SELECT * FROM effects WHERE marker = ?', marker).toArray())
})});`,
    },
  ],
}

/** Observe real requests without replacing the transport or the continuation manager. */
const recordingTransport = (sent: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return HttpClient.mapRequestEffect(client, (request) =>
        Effect.gen(function* () {
          if (request.url.endsWith('/mcp') && Predicate.isTagged(request.body, 'Uint8Array')) {
            const body = yield* decodeRequest(new TextDecoder().decode(request.body.body)).pipe(
              Effect.orDie,
            )
            yield* Ref.update(sent, (all) => [...all, body.params.name])
          }
          return request
        }),
      )
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici))

/** The restart is restricted to the disposable container explicitly passed to this proof. Await its health event. */
const restart = Effect.fn('IntegrationAsksProof.restart')(function* () {
  const container = NodeProcess.env['VIVID_TEST_EXECUTOR_CONTAINER']
  if (container === undefined) return expect.fail('Disposable Executor container is required')
  expect(
    NodeChildProcess.execFileSync(
      'docker',
      ['inspect', '--format', '{{index .Config.Labels "vivid.proof"}}', container],
      { encoding: 'utf8' },
    ).trim(),
  ).toBe('integration-asks')
  const since = new Date().toISOString()
  NodeChildProcess.execFileSync('docker', ['restart', '--timeout', '0', container])
  yield* Effect.callback<void>((resume) => {
    const events = NodeChildProcess.spawn('docker', [
      'events',
      '--since',
      since,
      '--filter',
      `container=${container}`,
      '--filter',
      'event=health_status',
      '--format',
      '{{.Action}}',
    ])
    let text = ''
    events.stdout.on('data', (chunk) => {
      text += String(chunk)
      if (text.includes('health_status: healthy')) {
        events.kill()
        resume(Effect.void)
      }
      if (text.includes('health_status: unhealthy')) {
        events.kill()
        resume(Effect.die('Disposable Executor became unhealthy'))
      }
    })
    events.on('error', (error) => resume(Effect.die(error)))
    return Effect.sync(() => {
      events.kill()
    })
  })
})

/** All answers cross Vivid's real stores, journal and member-authenticated beta.23 MCP transport. */
describe.skipIf(!enabled || !testDatabaseConfigured)('Integration continuations', () => {
  layer(Layer.merge(connectionTestLayer, trustTestLayer), {
    excludeTestServices: true,
    timeout: 240_000,
  })((it) => {
    it.effect(
      'resumes approvals and typed input, and journals lost sessions without reissuing',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const sent = yield* Ref.make<ReadonlyArray<string>>([])
          const real = yield* Layer.build(
            Layer.mergeAll(executorLayer, executorMembersLayer).pipe(
              Layer.provideMerge(recordingTransport(sent)),
              Layer.provideMerge(settings),
            ),
          )
          const stores = yield* Layer.build(Layer.fresh(connectionStoreLayer)).pipe(
            Effect.provide(real),
          )
          const context = Context.merge(real, stores)
          const runner = yield* Layer.build(
            actionRunnerLayer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(DeviceRegistry, {}),
                  Layer.mock(ComputerStore, {}),
                  Layer.mock(Watches, {}),
                ),
              ),
            ),
          ).pipe(Effect.provide(context))
          const approvalContext = yield* Layer.build(Layer.fresh(approvalStoreLayer)).pipe(
            Effect.provide(Context.merge(context, runner)),
          )
          const domains = Context.merge(context, approvalContext)
          const answers = yield* Layer.build(integrationAnswersLayer).pipe(Effect.provide(domains))
          const complete = Context.merge(domains, answers)
          const store = Context.get(complete, ConnectionStore)
          yield* Effect.addFinalizer(() =>
            store.records(test.personal).pipe(
              Effect.flatMap((rows) =>
                Effect.forEach(rows, (row) => store.remove(test.personal, row.id)),
              ),
              Effect.orDie,
            ),
          )
          yield* Effect.gen(function* () {
            const begun = yield* store.make(test.personal, app)
            const row = (yield* store.records(test.personal)).find(
              (item) => item.id === begun.connection.id,
            )
            if (row === undefined) return expect.fail('Expected the authored Connection')
            const operations = yield* operationsOf(row)
            const database = yield* Database
            const approvals = yield* ApprovalStore
            const inputs = yield* InputStore
            const start = Effect.fn('IntegrationAsksProof.start')(function* (
              tool: string,
              marker: string,
            ) {
              const target = ActionTarget.cases.Connection.make({
                connectionId: row.id,
                account: 'Proof',
                tool,
                input: { marker },
              })
              const operation = operationOf.program()
              yield* claim({
                id: operation,
                threadId: test.personalId,
                runId: null,
                approvalId: null,
                target,
              })
              return {
                operation,
                result: yield* runConnection(test.vivid, row, target, {
                  effect: 'write',
                  policy: DisplayCallPolicy.cases.Press.make({}),
                  operation: Option.some(operation),
                }),
              }
            })
            const refused = yield* operations.call({
              references: row.references,
              tool: 'inspect',
              input: {},
            })
            expect(ExecutorCallOutcome.guards.Rejected(refused)).toBe(true)
            if (!ExecutorCallOutcome.guards.Rejected(refused))
              return expect.fail('Expected ordinary input rejection')
            expect(refused.problems.length).toBeGreaterThan(0)
            const readId = ToolCallId.make(crypto.randomUUID())
            const ordinary = yield* useTool(test.vivid, {
              toolCallId: readId,
              connectionId: row.id,
              tool: 'inspect',
              input: { marker: 'never-written' },
              summary: 'Read proof',
              rationale: 'Prove ordinary reads remain unjournaled',
            })
            expect(ordinary.outcome).toEqual(
              ToolOutcome.cases.Completed.make({ output: [], receipt: null }),
            )
            expect(
              yield* database.run(
                database
                  .select()
                  .from(actions)
                  .where(eq(actions.id, operationOf.call(test.personalId, readId))),
              ),
            ).toHaveLength(0)
            const readPauseId = ToolCallId.make(crypto.randomUUID())
            const readPause = yield* useTool(test.vivid, {
              toolCallId: readPauseId,
              connectionId: row.id,
              tool: 'question',
              input: { marker: 'read-question' },
              summary: 'Name the read',
              rationale: 'Prove a read acquires its journal only when paused',
            })
            if (!ToolOutcome.guards.InputRequired(readPause.outcome))
              return expect.fail('Expected paused read')
            expect(
              yield* database.run(
                database
                  .select()
                  .from(actions)
                  .where(eq(actions.id, operationOf.call(test.personalId, readPauseId))),
              ),
            ).toHaveLength(1)
            yield* inputs.answerIntegration(test.personal, {
              id: readPause.outcome.requestId,
              response: { action: 'accept', content: { name: 'Ada' } },
            })
            const pendingBeforeDraw = (yield* inputs.inbox(test.personal)).length
            const drawn = yield* useQueryTool(test.vivid, {
              connectionId: row.id,
              tool: 'question',
              input: { marker: 'draw-question' },
              summary: 'Draw the question',
              rationale: 'A draw cannot ask the Person',
            })
            expect(ToolOutcome.guards.Rejected(drawn.outcome)).toBe(true)
            expect((yield* inputs.inbox(test.personal)).length).toBe(pendingBeforeDraw)
            const inspect = (marker: string) =>
              operations.call({ references: row.references, tool: 'inspect', input: { marker } })
            const parentTarget = ActionTarget.cases.Connection.make({
              connectionId: row.id,
              account: 'Proof',
              tool: 'approve',
              input: { marker: crypto.randomUUID() },
            })
            const initial = yield* approvals.raise(
              test.vivid,
              ProposedAction.make({
                summary: 'Record the approved proof',
                rationale: 'Prove the existing Vivid Approval path',
                effect: 'write',
                target: parentTarget,
              }),
              ApprovalBinding.make({
                connectionGeneration: row.authorizationGeneration,
                preconditions: [],
              }),
            )
            const waiting = yield* approvals.decide(test.personal, {
              id: initial.id,
              digest: initial.digest,
              decision: ApprovalDecision.cases.AllowOnce.make({}),
            })
            expect(ApprovalState.guards.Executing(waiting.state)).toBe(true)
            const continuation = (yield* approvals.inbox(test.personal)).find(
              (item) =>
                item.action.continuation !== null &&
                item.action.continuation.operation === operationOf.approval(initial.id),
            )
            if (continuation === undefined)
              return expect.fail('Expected an Integration Approval on the original operation')
            const parentBefore = (yield* Ref.get(sent)).length
            yield* approvals.decide(test.personal, {
              id: continuation.id,
              digest: continuation.digest,
              decision: ApprovalDecision.cases.AllowOnce.make({}),
            })
            expect((yield* Ref.get(sent)).slice(parentBefore)).toEqual(['resume'])
            const finished = (yield* approvals.inThread(test.personalId)).find(
              (item) => item.id === initial.id,
            )
            if (finished === undefined) return expect.fail('Expected the original Approval')
            expect(ApprovalState.guards.Succeeded(finished.state)).toBe(true)
            for (const decision of [
              ApprovalDecision.cases.AllowOnce.make({}),
              ApprovalDecision.cases.Deny.make({}),
              ApprovalDecision.cases.Cancel.make({}),
            ]) {
              const marker = crypto.randomUUID()
              const started = yield* start('approve', marker)
              expect(started.result.outcome._tag).toBe('ApprovalRequired')
              if (!ToolOutcome.guards.ApprovalRequired(started.result.outcome))
                return expect.fail('Expected Approval')
              const pendingId = started.result.outcome.approvalId
              const approval = (yield* approvals.inbox(test.personal)).find(
                (item) => item.id === pendingId,
              )
              if (approval === undefined) return expect.fail('Expected saved Approval')
              if (approval.action.continuation === null)
                return expect.fail('Expected saved continuation')
              expect(approval.action.continuation.operation).toBe(started.operation)
              expect(approval.action.continuation.pause._tag).toBe('Approval')
              const before = (yield* Ref.get(sent)).length
              const answered = yield* approvals.decide(test.personal, {
                id: approval.id,
                digest: approval.digest,
                decision,
              })
              expect((yield* Ref.get(sent)).slice(before)).toEqual(['resume'])
              if (answered.integrationOutcome === null)
                return expect.fail('Expected Integration answer')
              expect(answered.integrationOutcome._tag).toBe(
                ApprovalDecision.guards.AllowOnce(decision)
                  ? 'Completed'
                  : ApprovalDecision.guards.Deny(decision)
                    ? 'Declined'
                    : 'Cancelled',
              )
              const observed = yield* inspect(marker)
              expect(observed).toEqual(
                ExecutorCallOutcome.cases.Completed.make({
                  value: ApprovalDecision.guards.AllowOnce(decision)
                    ? [{ marker, phase: 'approved' }]
                    : [],
                }),
              )
            }
            const typed = yield* start('input', crypto.randomUUID())
            if (!ToolOutcome.guards.InputRequired(typed.result.outcome))
              return expect.fail('Expected Input request')
            const message = yield* Effect.succeed(typed.result.outcome)
            const request = (yield* inputs.inbox(test.personal)).find(
              (item) => item.id === message.requestId,
            )
            if (
              request === undefined ||
              request.integration === null ||
              request.integration.continuation === null ||
              request.integration === null
            )
              return expect.fail('Expected saved typed form')
            expect(request.integration.continuation.pause.form.requestedSchema.required).toEqual([
              'name',
              'count',
              'enabled',
              'color',
            ])
            const values = { name: 'Ada', count: 3, enabled: true, color: 'blue' }
            const typedBefore = (yield* Ref.get(sent)).length
            const answered = yield* inputs.answerIntegration(test.personal, {
              id: request.id,
              response: { action: 'accept', content: values },
            })
            expect(answered.outcome).toEqual(
              IntegrationAnswerOutcome.cases.Completed.make({
                value: { action: 'accept', content: values },
              }),
            )
            expect((yield* Ref.get(sent)).slice(typedBefore)).toEqual(['resume'])
            const approvalLost = yield* start('approve', crypto.randomUUID())
            const inputLost = yield* start('input', crypto.randomUUID())
            if (
              !ToolOutcome.guards.ApprovalRequired(approvalLost.result.outcome) ||
              !ToolOutcome.guards.InputRequired(inputLost.result.outcome)
            )
              return expect.fail('Expected two pauses')
            const approvalId = approvalLost.result.outcome.approvalId
            const savedApproval = (yield* approvals.inbox(test.personal)).find(
              (item) => item.id === approvalId,
            )
            if (savedApproval === undefined) return expect.fail('Expected Approval')
            const lostInput = yield* Effect.succeed(inputLost.result.outcome)
            yield* restart()
            const beforeLost = (yield* Ref.get(sent)).length
            const expiredApproval = yield* approvals.decide(test.personal, {
              id: savedApproval.id,
              digest: savedApproval.digest,
              decision: ApprovalDecision.cases.AllowOnce.make({}),
            })
            if (expiredApproval.integrationOutcome === null)
              return expect.fail('Expected expired outcome')
            expect(expiredApproval.integrationOutcome._tag).toBe('Expired')
            const expiredInput = yield* inputs.answerIntegration(test.personal, {
              id: lostInput.requestId,
              response: { action: 'accept', content: values },
            })
            expect(expiredInput.outcome._tag).toBe('Expired')
            expect((yield* Ref.get(sent)).slice(beforeLost)).toEqual(['resume', 'resume'])
            for (const id of [approvalLost.operation, inputLost.operation]) {
              const [saved] = yield* database.run(
                database.select().from(actions).where(eq(actions.id, id)),
              )
              if (saved === undefined) return expect.fail('Expected journaled uncertain operation')
              const receipt = yield* decodeReceipt(saved.receipt)
              expect(ActionReceipt.guards.Unknown(receipt)).toBe(true)
              expect(receipt.operationId).toBe(id)
            }
            const expiring = []
            for (const tool of ['approve', 'input', 'question']) {
              const parent = yield* approvals.raise(
                test.vivid,
                ProposedAction.make({
                  summary: `Expire ${tool}`,
                  rationale: 'Prove unanswered deadlines settle the original Approval',
                  effect: tool === 'question' ? 'read' : 'write',
                  target: ActionTarget.cases.Connection.make({
                    connectionId: row.id,
                    account: 'Proof',
                    tool,
                    input: { marker: crypto.randomUUID() },
                  }),
                }),
                ApprovalBinding.make({
                  connectionGeneration: row.authorizationGeneration,
                  preconditions: [],
                }),
              )
              yield* approvals.decide(test.personal, {
                id: parent.id,
                digest: parent.digest,
                decision: ApprovalDecision.cases.AllowOnce.make({}),
              })
              expiring.push(parent.id)
            }
            const future = (yield* Clock.currentTimeMillis) + 16 * 60 * 1000
            const actualClock = yield* Clock.clockWith(Effect.succeed)
            const expiryClock: Clock.Clock = {
              currentTimeMillisUnsafe: () => future,
              currentTimeMillis: Effect.succeed(future),
              currentTimeNanosUnsafe: () => BigInt(future) * 1_000_000n,
              currentTimeNanos: Effect.succeed(BigInt(future) * 1_000_000n),
              monotonicTimeNanosUnsafe: () => actualClock.monotonicTimeNanosUnsafe(),
              monotonicTimeNanos: actualClock.monotonicTimeNanos,
              sleep: (duration) => actualClock.sleep(duration),
            }
            const beforeExpiry = (yield* Ref.get(sent)).length
            yield* Effect.all([approvals.expire, inputs.expire], { concurrency: 1 }).pipe(
              Effect.provideService(Clock.Clock, expiryClock),
            )
            expect((yield* Ref.get(sent)).length).toBe(beforeExpiry)
            for (const id of expiring) {
              const parent = (yield* approvals.inThread(test.personalId)).find(
                (item) => item.id === id,
              )
              if (parent === undefined || parent.integrationOutcome === null)
                return expect.fail('Expected expired parent')
              expect(ApprovalState.guards.OutcomeUnknown(parent.state)).toBe(true)
              expect(IntegrationAnswerOutcome.guards.Expired(parent.integrationOutcome)).toBe(true)
              const [saved] = yield* database.run(
                database
                  .select()
                  .from(actions)
                  .where(eq(actions.id, operationOf.approval(id))),
              )
              if (saved === undefined) return expect.fail('Expected original uncertain receipt')
              expect(ActionReceipt.guards.Unknown(yield* decodeReceipt(saved.receipt))).toBe(true)
            }
            const expiredInputs = yield* inputs.inThread(test.personalId)
            expect(expiredInputs.some((item) => InputRequestState.guards.Expired(item.state))).toBe(
              true,
            )
            const doomed = yield* store.make(test.personal, {
              ...app,
              name: 'Failure after input claim',
            })
            const doomedRow = (yield* store.records(test.personal)).find(
              (item) => item.id === doomed.connection.id,
            )
            if (doomedRow === undefined) return expect.fail('Expected disposable second Connection')
            const failedOperation = operationOf.program()
            const failedTarget = ActionTarget.cases.Connection.make({
              connectionId: doomedRow.id,
              account: 'Proof',
              tool: 'input',
              input: { marker: crypto.randomUUID() },
            })
            yield* claim({
              id: failedOperation,
              threadId: test.personalId,
              runId: null,
              approvalId: null,
              target: failedTarget,
            })
            const asked = yield* runConnection(test.vivid, doomedRow, failedTarget, {
              effect: 'write',
              operation: Option.some(failedOperation),
              policy: DisplayCallPolicy.cases.Press.make({}),
            })
            if (!ToolOutcome.guards.InputRequired(asked.outcome))
              return expect.fail('Expected input before Connection removal')
            // An unrelated caller cannot recover another Person's in-flight answer before winning a claim.
            yield* database.run(
              database
                .update(inputRequests)
                .set({ status: 'answering' })
                .where(eq(inputRequests.id, asked.outcome.requestId)),
            )
            const denied = yield* inputs
              .answerIntegration(test.other, {
                id: asked.outcome.requestId,
                response: { action: 'decline' },
              })
              .pipe(Effect.result)
            expect(Result.isFailure(denied)).toBe(true)
            const [stillHeld] = yield* database.run(
              database
                .select()
                .from(inputRequests)
                .where(eq(inputRequests.id, asked.outcome.requestId)),
            )
            if (stillHeld === undefined) return expect.fail('Expected the addressed request')
            expect(stillHeld.status).toBe('answering')
            yield* database.run(
              database
                .update(inputRequests)
                .set({ status: 'waiting' })
                .where(eq(inputRequests.id, asked.outcome.requestId)),
            )
            yield* store.remove(test.personal, doomedRow.id)
            const uncertain = yield* inputs.answerIntegration(test.personal, {
              id: asked.outcome.requestId,
              response: {
                action: 'accept',
                content: { name: 'Ada', count: 1, enabled: true, color: 'red' },
              },
            })
            expect(IntegrationAnswerOutcome.guards.Uncertain(uncertain.outcome)).toBe(true)
            expect(InputRequestState.guards.Answered(uncertain.request.state)).toBe(true)
            const [failedReceipt] = yield* database.run(
              database.select().from(actions).where(eq(actions.id, failedOperation)),
            )
            if (failedReceipt === undefined) return expect.fail('Expected failed claim receipt')
            expect(ActionReceipt.guards.Unknown(yield* decodeReceipt(failedReceipt.receipt))).toBe(
              true,
            )
          }).pipe(Effect.provide(complete))
        }),
      { timeout: 240_000 },
    )
  })
})
