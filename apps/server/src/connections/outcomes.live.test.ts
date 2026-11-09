import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { toolOutcome } from '@vivid/agent-runtime/tooltesting'
import { ActionReceipt, ToolCallId, ToolOutcome } from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { ConfigProvider, Context, Effect, Layer, Result, Schema } from 'effect'
import { actions } from '../actions/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { threads } from '../threads/tables.ts'
import { executorLayer } from './executor.ts'
import { executorMembersLayer } from './members.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connectionTestLayer, fixture } from './testing.ts'
import { useTool } from './tools.ts'

const enabled = NodeProcess.env['VIVID_LIVE_OUTCOMES'] === '1'
const settings = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    GOOGLE_CLIENT_ID: 'isolated-test-client',
    GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
    VIVID_EXECUTOR_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
    VIVID_EXECUTOR_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_KEY'],
    VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
    VIVID_EXECUTOR_OWNER_EMAIL: NodeProcess.env['VIVID_TEST_EXECUTOR_OWNER_EMAIL'],
    VIVID_EXECUTOR_OWNER_PASSWORD: NodeProcess.env['VIVID_TEST_EXECUTOR_OWNER_PASSWORD'],
    VIVID_EXECUTOR_SEAL_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_SEAL_KEY'],
  }),
)
const realExecutor = Layer.mergeAll(executorLayer, executorMembersLayer).pipe(
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(settings),
)

/** The authored provider returns explicit acceptance answers; its completed tool first saves a
 * record in Executor's real SQLite database, so that answer names a result that exists. */
const request = {
  name: 'Outcome proof',
  files: [
    {
      path: 'index.ts',
      content: `import { mutation, defineApp, defineDatabase, table, object, string, json } from "apps";
const database = defineDatabase({ records: table({ subject: string() }) });
export default defineApp({ accounts: {}, database }, async () => ({ tools: {
  accept: mutation({ description: "Accept work without confirming completion", input: object({ answer: json() }), output: json() }, async (_, input) => input.answer),
  complete: mutation({ description: "Save a result before confirming completion", input: object({ subject: string() }), output: json() }, async ({ db }, input) => ({ id: await db.records.insert(input) }))
} }));`,
    },
  ],
}
const acceptedAnswers: ReadonlyArray<Schema.Json> = [
  { status: 'accepted' },
  { status: 'queued', jobId: 'queued-job' },
  { status: 'scheduled' },
  { status: 'pending' },
  { status: 202 },
  { statusCode: 202 },
  { accepted: true },
  { jobId: 'check-this-job-later' },
  { name: 'operations/drive-download' },
  { name: 'operations/drive-download', done: false },
  { name: 'operations/drive-download', done: null },
  { structuredContent: { status: 'queued' }, content: [] },
]
const decodeReceipt = Schema.decodeUnknownEffect(ActionReceipt)

/** Real beta.23 calls cross the production adapter and journal; no provider HTTP answer is mocked.
 * Gate admission uses the shared fixture because this proof tests outcome evidence, not policy. */
describe.skipIf(!enabled || !testDatabaseConfigured)('Integration acceptance receipts', () => {
  layer(connectionTestLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
    it.effect(
      'keeps accepted work unfinished in the journal and model words, and completes a saved result',
      () =>
        Effect.gen(function* () {
          const { personalActor, threadId } = yield* fixture()
          const database = yield* Database
          yield* database.run(
            database
              .update(threads)
              .set({ companyId: null, audience: 'private' })
              .where(eq(threads.id, threadId)),
          )
          const real = yield* Layer.build(realExecutor)
          const built = yield* Layer.build(Layer.fresh(connectionStoreLayer)).pipe(
            Effect.provide(real),
          )
          const context = Context.merge(real, built)
          const store = Context.get(context, ConnectionStore)
          yield* Effect.addFinalizer(() =>
            store.records(personalActor).pipe(
              Effect.flatMap((rows) =>
                Effect.forEach(rows, (row) => store.remove(personalActor, row.id)),
              ),
              Effect.result,
              Effect.map((result) => expect(Result.isSuccess(result)).toBe(true)),
            ),
          )
          yield* Effect.gen(function* () {
            const begun = yield* store.make(personalActor, request)
            const send = (tool: string, input: Schema.Json) =>
              useTool(personalActor, {
                toolCallId: ToolCallId.make(crypto.randomUUID()),
                connectionId: begun.connection.id,
                tool,
                input,
                summary: 'Exercise provider outcome evidence',
                rationale: 'Disposable acceptance proof',
              })
            for (const answer of acceptedAnswers) {
              const result = yield* send('accept', { answer })
              expect(result.outcome._tag).toBe('Accepted')
              if (!ToolOutcome.guards.Accepted(result.outcome) || result.outcome.receipt === null)
                return expect.fail('Expected journaled acceptance')
              const receipt = result.outcome.receipt
              const [saved] = yield* database.run(
                database.select().from(actions).where(eq(actions.id, receipt.operationId)),
              )
              if (saved === undefined) return expect.fail('Expected journal row')
              expect(yield* decodeReceipt(saved.receipt)).toEqual(receipt)
              const words = toolOutcome(result)
              expect(words.output).toMatchObject({
                ok: true,
                output: answer,
                message: expect.stringContaining('queued, not confirmed yet'),
              })
              expect(words.receipts).toEqual([receipt])
              const repeated = yield* send('accept', { answer })
              expect(repeated.outcome._tag).toBe('Repeated')
              expect(toolOutcome(repeated).output).toMatchObject({
                message: expect.stringContaining('queued, not confirmed yet'),
              })
              expect(JSON.stringify(toolOutcome(repeated).output)).not.toContain('already done')
            }
            const result = yield* send('complete', { subject: 'A saved result' })
            expect(result.outcome._tag).toBe('Completed')
            if (!ToolOutcome.guards.Completed(result.outcome) || result.outcome.receipt === null)
              return expect.fail('Expected journaled completion')
            expect(result.outcome.receipt._tag).toBe('Completed')
            const [saved] = yield* database.run(
              database
                .select()
                .from(actions)
                .where(eq(actions.id, result.outcome.receipt.operationId)),
            )
            if (saved === undefined) return expect.fail('Expected completed journal row')
            expect(yield* decodeReceipt(saved.receipt)).toEqual(result.outcome.receipt)
            expect(toolOutcome(result).output).toMatchObject({
              ok: true,
              message: 'The service answered that the action is done.',
            })
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped),
    )
  })
})
