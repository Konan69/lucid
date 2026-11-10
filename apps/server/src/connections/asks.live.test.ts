import { actionRunnerLayer } from '../approvals/runner.ts'
import { DeviceRegistry } from '../computers/device.ts'
import { ComputerStore } from '../computers/store.ts'
import { Watches } from '../watches/lifecycle.ts'
import * as NodeProcess from 'node:process'
import * as NodeChildProcess from 'node:child_process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import {
  ApprovalState,
  ActionReceipt,
  ToolCallId,
  ApprovalDecision,
  IntegrationAnswerOutcome,
  ToolOutcome,
  AuditEvent,
} from '@vivid/contracts'
import { ConfigProvider, Context, Effect, Layer, Predicate, Ref, Schema } from 'effect'
import { HttpClient } from 'effect/http'
import { eq } from 'drizzle-orm'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { actions } from '../actions/tables.ts'
import { ApprovalStore, approvalStoreLayer } from '../approvals/store.ts'
import { InputStore } from '../inputs/store.ts'
import {
  trustTestLayer,
  fixture,
  Observation,
  recordRuns,
  history,
  delivery,
} from '../approvals/testing.ts'
import { connectionTestLayer } from './testing.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { ExecutorCallOutcome, executorLayer } from './executor.ts'
import { executorMembersLayer, operationsOf } from './members.ts'
import { integrationAnswersLayer } from './asks.ts'
import { gateLayer } from '../approvals/gate.ts'
import { Review } from '../approvals/policy.ts'
import { reviewerLayer } from '../approvals/review.ts'
import { DecisionModel } from 'effect/ai'
import { ScriptedAnswer } from '../decisions/testing.ts'
import { Runtime } from '../runtime/client.ts'
import { StoredRunOrigin } from '../threads/conversation.ts'
import { loadAudit } from '../audit/store.ts'
import { namedAccounts } from './names.ts'
import { useDisplayTool, useTool, useQueryTool } from './tools.ts'

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
  input: mutation({ input, description: 'Ask for typed values after approval', approval: always() }, async (ctx, {marker}) => {
    ctx.sql.exec('INSERT INTO effects VALUES (?, ?)', marker, 'before-input');
    const answer = await ctx.elicit({mode:'form', message:'Name and configure this result', requestedSchema:{
      type:'object', properties:{name:{type:'string',description:'Result name'},count:{type:'integer'},enabled:{type:'boolean'},color:{type:'string',enum:['red','blue']},note:{type:'string'}}, required:['name','count','enabled','color']
    }});
    ctx.sql.exec('UPDATE effects SET phase = ? WHERE marker = ?', JSON.stringify(answer), marker);
    return answer;
  }),
  question: query({input,description:'Ask without a write',approval:always()}, async (ctx) => ctx.elicit({mode:'form',message:'Name the read',requestedSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}})),
  denied: mutation({input,description:'Refuse dynamically',approval:()=> 'denied'}, async (ctx,{marker}) => {ctx.sql.exec('INSERT INTO effects VALUES (?, ?)',marker,'should-not-run');return {marker};}),
  large: query({input:object({}),description:'Read a complete large result'}, async () => 'x'.repeat(150_000)),
  bare: mutation({input,description:'Act before an unsupported REST input request'}, async (ctx,{marker}) => { ctx.sql.exec('INSERT INTO effects VALUES (?, ?)',marker,'before-input'); return await ctx.elicit({mode:'form',message:'Unsafe to repeat',requestedSchema:{type:'object',properties:{name:{type:'string'}},required:['name']}}); }),
  inspect: query({input,description:'Read the proof effect'}, async (ctx, {marker}) => ctx.sql.exec('SELECT * FROM effects WHERE marker = ?', marker).toArray())
})});`,
    },
  ],
}

/** Observe real requests without replacing the transport or the continuation manager. */
const recordingTransport = (sent: Ref.Ref<ReadonlyArray<string>>, loseApproval: Ref.Ref<boolean>) =>
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
            if (body.params.name === 'resume' && (yield* Ref.getAndSet(loseApproval, false)))
              yield* restart()
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
  ).toMatch(/^(integration-asks|retire-adoption|one-decider)$/u)
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
      'accepts only the provider layer, preserves Vivid decisions and typed forms, and never reissues lost calls',
      () =>
        Effect.gen(function* () {
          const test = yield* fixture()
          const sent = yield* Ref.make<ReadonlyArray<string>>([])
          const loseApproval = yield* Ref.make(false)
          const real = yield* Layer.build(
            Layer.mergeAll(executorLayer, executorMembersLayer).pipe(
              Layer.provideMerge(recordingTransport(sent, loseApproval)),
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
                  Layer.mock(Watches, { confirmTimer: () => Effect.void }),
                ),
              ),
            ),
          ).pipe(Effect.provide(context))
          const approvalContext = yield* Layer.build(Layer.fresh(approvalStoreLayer)).pipe(
            Effect.provide(Context.merge(context, runner)),
          )
          const domains = Context.merge(context, approvalContext)
          // Keep the real Reviewer and Gate. Only the external Decision provider and history
          // are scripted; beta.23 execution, PostgreSQL, approvals and receipts are real.
          yield* recordRuns(test.personalId, [
            {
              id: 'now',
              personId: test.personal.person.id,
              origin: StoredRunOrigin.cases.Message.make({}),
              working: true,
            },
          ])
          const observed = yield* Observation
          const model = yield* DecisionModel.make({
            decide: () =>
              Effect.gen(function* () {
                const review = yield* Ref.get(observed.review)
                if (!Review.guards.Reviewed(review))
                  return yield* Effect.die('Expected scripted measurements')
                return {
                  answers: {
                    asked: ScriptedAnswer.cases.Probability.make({ probability: review.asked }),
                    beyond: ScriptedAnswer.cases.Probability.make({ probability: review.beyond }),
                    consequence: ScriptedAnswer.cases.Classify.make({
                      label: 'reaches',
                      probabilities: {
                        contained: review.contained,
                        reaches: 1 - review.contained,
                        irreversible: 0,
                      },
                    }),
                  },
                  usage: { inputTokens: undefined, outputTokens: undefined },
                }
              }),
          })
          const gate = yield* Layer.build(
            Layer.fresh(gateLayer).pipe(
              Layer.provideMerge(reviewerLayer),
              Layer.provideMerge(Layer.succeed(DecisionModel.DecisionModel, model)),
              Layer.provideMerge(
                Layer.mock(
                  Runtime,
                  history([delivery(test.personalId, 'now', null, 'Run the proof tool')]),
                ),
              ),
            ),
          ).pipe(Effect.provide(domains))
          const gated = Context.merge(domains, gate)
          const answers = yield* Layer.build(integrationAnswersLayer).pipe(Effect.provide(gated))
          const complete = Context.merge(gated, answers)
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
            yield* Ref.set(
              observed.review,
              Review.cases.Reviewed.make({
                asked: 0.95,
                beyond: 0.1,
                contained: 0.1,
              }),
            )
            const start = (tool: string, marker: string) =>
              useTool(test.vivid, {
                toolCallId: ToolCallId.make(crypto.randomUUID()),
                connectionId: row.id,
                tool,
                input: { marker },
                summary: `Run ${tool} for the Person`,
                rationale: 'Exercise the real continuation',
              })
            const inspect = (marker: string) =>
              operations.call({
                references: row.references,
                tool: 'inspect',
                input: { marker },
              })
            const largeBefore = (yield* Ref.get(sent)).length
            expect(
              yield* operations.call({ references: row.references, tool: 'large', input: {} }),
            ).toEqual(ExecutorCallOutcome.cases.Completed.make({ value: 'x'.repeat(150_000) }))
            expect((yield* Ref.get(sent)).length).toBe(largeBefore)
            const bareMarker = crypto.randomUUID()
            expect((yield* start('bare', bareMarker)).outcome._tag).toBe('OutcomeUnknown')
            expect((yield* Ref.get(sent)).length).toBe(largeBefore)
            expect(yield* inspect(bareMarker)).toEqual(
              ExecutorCallOutcome.cases.Completed.make({
                value: [{ marker: bareMarker, phase: 'before-input' }],
              }),
            )
            const invalid = yield* operations.call({
              references: row.references,
              tool: 'inspect',
              input: {},
            })
            if (!ExecutorCallOutcome.guards.Rejected(invalid))
              return expect.fail('Expected input rejection')
            expect(invalid.problems.length).toBeGreaterThan(0)
            const marker = crypto.randomUUID()
            const before = (yield* Ref.get(sent)).length
            const allowed = yield* start('approve', marker)
            expect(allowed.outcome._tag).toBe('Completed')
            expect((yield* Ref.get(sent)).slice(before)).toEqual(['call', 'resume'])
            expect(yield* inspect(marker)).toEqual(
              ExecutorCallOutcome.cases.Completed.make({ value: [{ marker, phase: 'approved' }] }),
            )
            expect(yield* approvals.inThread(test.personalId)).toHaveLength(0)
            expect(
              (yield* loadAudit(test.personal)).entries.some(
                (entry) =>
                  entry.by === 'vivid' &&
                  AuditEvent.guards.ActionAllowed(entry.event) &&
                  entry.event.tool === 'approve',
              ),
            ).toBe(true)

            yield* Ref.set(
              observed.review,
              Review.cases.Reviewed.make({
                asked: 0.1,
                beyond: 0.9,
                contained: 0.1,
              }),
            )
            const askedMarker = crypto.randomUUID()
            const asked = yield* start('approve', askedMarker)
            if (!ToolOutcome.guards.ApprovalRequired(asked.outcome))
              return expect.fail('Expected Vivid to ask before dispatch')
            const pending = (yield* approvals.inbox(test.personal)).find(
              (entry) =>
                ToolOutcome.guards.ApprovalRequired(asked.outcome) &&
                entry.id === asked.outcome.approvalId,
            )
            if (pending === undefined) return expect.fail('Expected Vivid Approval')
            expect(pending.action.continuation).toBeNull()
            expect(yield* inspect(askedMarker)).toEqual(
              ExecutorCallOutcome.cases.Completed.make({ value: [] }),
            )
            const approved = yield* approvals.decide(test.personal, {
              id: pending.id,
              digest: pending.digest,
              decision: ApprovalDecision.cases.AllowOnce.make({}),
            })
            expect(ApprovalState.guards.Succeeded(approved.state)).toBe(true)
            expect(yield* approvals.inThread(test.personalId)).toHaveLength(1)
            expect(yield* inspect(askedMarker)).toEqual(
              ExecutorCallOutcome.cases.Completed.make({
                value: [{ marker: askedMarker, phase: 'approved' }],
              }),
            )

            const account = namedAccounts([row])[0]
            if (account === undefined) return expect.fail('Expected named account')
            const displayMarker = crypto.randomUUID()
            const displayed = yield* useDisplayTool(test.personal, {
              name: `approve@${account.account}`,
              kind: 'Mutation',
              input: { marker: displayMarker },
            })
            expect(displayed.outcome._tag).toBe('Completed')
            expect(
              (yield* loadAudit(test.personal)).entries.some(
                (entry) =>
                  entry.by === 'person' &&
                  AuditEvent.guards.ActionAllowed(entry.event) &&
                  entry.event.tool === 'approve',
              ),
            ).toBe(true)
            expect(yield* inspect(displayMarker)).toEqual(
              ExecutorCallOutcome.cases.Completed.make({
                value: [{ marker: displayMarker, phase: 'approved' }],
              }),
            )

            yield* Ref.set(
              observed.review,
              Review.cases.Reviewed.make({
                asked: 0.95,
                beyond: 0.1,
                contained: 0.1,
              }),
            )
            const deniedMarker = crypto.randomUUID()
            expect((yield* start('denied', deniedMarker)).outcome._tag).toBe('Rejected')
            expect(yield* inspect(deniedMarker)).toEqual(
              ExecutorCallOutcome.cases.Completed.make({ value: [] }),
            )
            yield* Ref.set(loseApproval, true)
            const lostApprovalMarker = crypto.randomUUID()
            const lostBefore = (yield* Ref.get(sent)).length
            const lostApproval = yield* start('approve', lostApprovalMarker)
            expect(lostApproval.outcome._tag).toBe('OutcomeUnknown')
            expect((yield* Ref.get(sent)).slice(lostBefore)).toEqual(['call', 'resume'])
            if (
              !ToolOutcome.guards.OutcomeUnknown(lostApproval.outcome) ||
              lostApproval.outcome.receipt === null
            )
              return expect.fail('Expected journaled lost approval')
            const [lostReceipt] = yield* database.run(
              database
                .select()
                .from(actions)
                .where(eq(actions.id, lostApproval.outcome.receipt.operationId)),
            )
            if (lostReceipt === undefined) return expect.fail('Expected held operation')
            expect(ActionReceipt.guards.Unknown(yield* decodeReceipt(lostReceipt.receipt))).toBe(
              true,
            )
            expect(yield* inspect(lostApprovalMarker)).toEqual(
              ExecutorCallOutcome.cases.Completed.make({ value: [] }),
            )

            const typed = yield* start('input', crypto.randomUUID())
            if (!ToolOutcome.guards.InputRequired(typed.outcome))
              return expect.fail('Expected typed input')
            const inputId = typed.outcome.requestId
            const input = (yield* inputs.inbox(test.personal)).find((entry) => entry.id === inputId)
            if (
              input === undefined ||
              input.integration === null ||
              input.integration.continuation === null
            )
              return expect.fail('Expected saved typed form')
            expect(input.integration.continuation.pause.form.requestedSchema.required).toEqual([
              'name',
              'count',
              'enabled',
              'color',
            ])
            const values = { name: 'Ada', count: 3, enabled: true, color: 'blue' }
            const inputBefore = (yield* Ref.get(sent)).length
            const answered = yield* inputs.answerIntegration(test.personal, {
              id: inputId,
              response: { action: 'accept', content: values },
            })
            expect(answered.outcome).toEqual(
              IntegrationAnswerOutcome.cases.Completed.make({
                value: { action: 'accept', content: values },
              }),
            )
            expect((yield* Ref.get(sent)).slice(inputBefore)).toEqual(['resume'])

            const query = yield* start('question', crypto.randomUUID())
            expect(query.outcome._tag).toBe('InputRequired')
            const drawn = yield* useQueryTool(test.vivid, {
              connectionId: row.id,
              tool: 'question',
              input: { marker: 'draw' },
              summary: 'Draw a read',
              rationale: 'Draws cannot ask for information',
            })
            expect(drawn.outcome._tag).toBe('Rejected')
            const lost = yield* start('input', crypto.randomUUID())
            if (!ToolOutcome.guards.InputRequired(lost.outcome))
              return expect.fail('Expected saved input')
            const lostId = lost.outcome.requestId
            const savedInput = (yield* inputs.inbox(test.personal)).find(
              (entry) => entry.id === lostId,
            )
            if (
              savedInput === undefined ||
              savedInput.integration === null ||
              savedInput.integration.continuation === null
            )
              return expect.fail('Expected journaled input')
            const operation = savedInput.integration.continuation.operation
            yield* restart()
            const resumeBefore = (yield* Ref.get(sent)).length
            const expired = yield* inputs.answerIntegration(test.personal, {
              id: lostId,
              response: { action: 'accept', content: values },
            })
            expect(expired.outcome._tag).toBe('Expired')
            expect((yield* Ref.get(sent)).slice(resumeBefore)).toEqual(['resume'])
            const [saved] = yield* database.run(
              database.select().from(actions).where(eq(actions.id, operation)),
            )
            if (saved === undefined) return expect.fail('Expected uncertain receipt')
            expect(ActionReceipt.guards.Unknown(yield* decodeReceipt(saved.receipt))).toBe(true)
          }).pipe(Effect.provide(complete))
        }),
      { timeout: 240_000 },
    )
  })
})
