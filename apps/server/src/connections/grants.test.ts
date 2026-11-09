import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer, Ref } from 'effect'
import {
  ConnectionGrant,
  ConnectionState,
  CoverageReason,
  ResultAsOf,
  ResultCount,
  ResultContinuation,
  ResultQuery,
  ResultCoverage,
  ServiceId,
  ToolCallId,
  ToolOutcome,
} from '@vivid/contracts'
import { toolOutcome, boundIntegrationOutput } from '@vivid/agent-runtime/tooltesting'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { Executor, ExecutorCallOutcome, ExecutorServiceEntry, ExecutorTool } from './executor.ts'
import { ConnectionProbe, connectionTestLayer, fixture } from './testing.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { useTool, useDisplayTool } from './tools.ts'

const gmail = ServiceId.make('google/gmail')
const operation = 'gmailApi.gmailUsersMessagesList'

/** Product persistence and all invocation paths share the real DB. The external Executor is controlled,
 * so this proves Vivid's receipts/admission, not Google's real consent or pagination implementation. */
describe.skipIf(!testDatabaseConfigured)('Integration grants and coverage', () => {
  layer(connectionTestLayer)((it) => {
    it.effect(
      'persists lapsed grants, preserves page evidence through clipping, and refuses excluded classes',
      () =>
        Effect.gen(function* () {
          const executor = yield* Executor
          const catalog = executor.catalog.pipe(
            Effect.map((entries) =>
              entries.map((entry) =>
                ExecutorServiceEntry.make({ ...entry, id: gmail, name: 'Gmail' }),
              ),
            ),
          )
          const context = yield* Layer.build(Layer.fresh(connectionStoreLayer)).pipe(
            Effect.provideService(Executor, Executor.of({ ...executor, catalog })),
          )
          return yield* Effect.gen(function* () {
            const { ownerActor } = yield* fixture()
            const store = yield* ConnectionStore
            const probe = yield* ConnectionProbe
            const priorTools = yield* Ref.get(probe.tools)
            const priorOutcome = yield* Ref.get(probe.outcome)
            yield* Effect.addFinalizer(() =>
              Ref.set(probe.tools, priorTools).pipe(
                Effect.andThen(Ref.set(probe.outcome, priorOutcome)),
              ),
            )
            yield* Ref.set(probe.tools, [
              ExecutorTool.make({
                name: operation,
                description: 'List messages',
                effect: 'read',
                input: {},
              }),
            ])
            const { connection } = yield* store.begin(ownerActor, {
              service: gmail,
              from: 'Web',
              name: null,
              shared: false,
            })
            const input = { path: { userId: 'me' }, query: { maxResults: 50 } }
            // A read is never journaled, so the three calls below may share one call identity.
            const request = {
              toolCallId: ToolCallId.make(crypto.randomUUID()),
              connectionId: connection.id,
              tool: operation,
              input,
              summary: 'Read messages',
              rationale: 'Answer the request',
            }
            const messages = Array.from({ length: 50 }, (_, index) => ({ id: String(index) }))
            yield* Ref.set(
              probe.outcome,
              ExecutorCallOutcome.cases.Completed.make({
                value: { messages, nextPageToken: 'next-page' },
              }),
            )
            const page = yield* useTool(ownerActor, request)
            const query = ResultQuery.make({
              account: 'Gmail',
              operation,
              input,
              fetched: ResultCount.cases.Known.make({ value: 50, unit: 'messages' }),
              total: ResultCount.cases.Unknown.make({}),
              continuation: ResultContinuation.cases.Next.make({
                input: {
                  path: { userId: 'me' },
                  query: { maxResults: 50, pageToken: 'next-page' },
                },
              }),
            })
            expect(ToolOutcome.guards.Completed(page.outcome)).toBe(true)
            expect(page.asOf).toEqual(ResultAsOf.cases.Unknown.make({}))
            expect(page.coverage).toEqual(
              ResultCoverage.cases.Partial.make({
                query,
                reasons: [CoverageReason.cases.Pagination.make({})],
              }),
            )
            expect(Number.isFinite(page.observedAt)).toBe(true)
            const projected = boundIntegrationOutput(toolOutcome(page).output, page)
            expect(projected).toMatchObject({
              output: { messages: messages.slice(0, 25), truncated: true },
              coverage: ResultCoverage.cases.Partial.make({
                query,
                reasons: [
                  CoverageReason.cases.Pagination.make({}),
                  CoverageReason.cases.OutputClipped.make({}),
                ],
              }),
              sourceCoverage: page.coverage,
            })
            const allowed = yield* store.permission(ownerActor, {
              id: connection.id,
              dataClass: 'GmailDrafts',
              decision: 'Never',
            })
            expect(allowed.permissions).toEqual([{ dataClass: 'GmailDrafts', decision: 'Never' }])
            const calls = yield* Ref.get(probe.calls)
            const refused = yield* useTool(ownerActor, request)
            const display = yield* useDisplayTool(ownerActor, {
              name: operation + '@Gmail',
              input,
              kind: 'Query',
            })
            for (const result of [refused, display]) {
              expect(ToolOutcome.guards.PermissionDeclined(result.outcome)).toBe(true)
              expect(ResultCoverage.guards.NotRead(result.coverage)).toBe(true)
            }
            expect(yield* Ref.get(probe.calls)).toBe(calls)
            yield* store.permission(ownerActor, {
              id: connection.id,
              dataClass: 'GmailDrafts',
              decision: 'Allow',
            })
            yield* Ref.set(probe.outcome, ExecutorCallOutcome.cases.NotReady.make({}))
            const lapsed = yield* useTool(ownerActor, request)
            if (!ToolOutcome.guards.ConnectionNotReady(lapsed.outcome))
              expect.fail('Expected a lapsed sign-in receipt')
            expect(lapsed.outcome.grant).toEqual(
              ConnectionGrant.cases.ReauthorizationRequired.make({}),
            )
            const persisted = (yield* store.list(ownerActor)).connections.find(
              (entry) => entry.id === connection.id,
            )
            expect(persisted).toMatchObject({
              state: ConnectionState.cases.NeedsAuthorization.make({}),
              grant: ConnectionGrant.cases.ReauthorizationRequired.make({}),
            })
            const row = yield* store.get(ownerActor, connection.id)
            expect(row.grantObservation).not.toBeNull()
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped),
    )
  })
})
