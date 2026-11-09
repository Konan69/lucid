import * as NodeProcess from 'node:process'
import * as NodeBuffer from 'node:buffer'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import {
  ActionReconciliation,
  ActionReconciliationRequired,
  ServiceId,
  ToolCallId,
  ToolOutcome,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import { ConfigProvider, Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import type { Actor } from '../auth/access.ts'
import { reconcile } from '../actions/journal.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { executorLayer } from './executor.ts'
import { executorMembersLayer, operationsOf } from './members.ts'
import { actionLookupLayer } from './reconcile.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { connections } from './tables.ts'
import { connectionTestLayer, fixture } from './testing.ts'
import { useTool } from './tools.ts'

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

/** A provider stand-in commits the effect, then loses its answer. Search reads its real SQLite.
 * Personal account routing makes an accidental installation-key lookup fail at Executor itself. */
const request = {
  name: 'Reconciliation proof',
  files: [
    {
      path: 'index.ts',
      content: `import { query, mutation, defineApp, defineProvider, secrets, object, string, json, router, accountRouter } from "apps";
const service = defineProvider({ name: "Reconciliation proof", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
const requirements = { user: { accounts: { service: service.many() } } };
export default defineApp(requirements, async ({ user, signal }) => ({ tools: await accountRouter(user?.accounts.service ?? [], () => router({
  gmailApi: router({
    gmailUsersMessagesSend: mutation({ description: "Send mail", input: object({ path: object({ userId: string() }), body: object({ raw: string() }) }) }, async ({ sql }, input) => {
      const mime = atob(input.body.raw.replace(/-/g, "+").replace(/_/g, "/"));
      const marker = /^Message-ID: <([^>]+)>/m.exec(mime)?.[1];
      if (!marker || mime.split(String.fromCharCode(10)).filter((line) => line.startsWith("Message-ID:")).length !== 1) throw new Error("Missing unique journal marker");
      sql.exec("INSERT INTO attempts (marker) VALUES (?)", marker);
      if (!mime.includes("Subject: absent")) sql.exec("INSERT INTO effects (id) VALUES (?)", marker);
      throw new Error("Provider response lost after dispatch");
    }),
    gmailUsersMessagesList: query({ description: "Search mail", input: object({ path: object({ userId: string() }), query: object({ q: string(), includeSpamTrash: json(), maxResults: json() }) }) }, async ({ sql }, input) => {
      const marker = /^rfc822msgid:<([^>]+)>$/.exec(input.query.q)?.[1];
      if (!marker) throw new Error("Expected exact operation search");
      return { messages: sql.exec("SELECT id FROM effects WHERE id = ?", marker).toArray() };
    }),
  }),
  calendarApi: router({
    calendarEventsInsert: mutation({ description: "Create event", input: object({ path: object({ calendarId: string() }), body: object({ summary: string(), extendedProperties: object({ private: object({ vividOperation: string() }) }) }) }) }, async ({ sql }, input) => {
      const marker = input.body.extendedProperties.private.vividOperation;
      sql.exec("INSERT INTO attempts (marker) VALUES (?)", marker);
      if (input.body.summary !== "absent") sql.exec("INSERT INTO effects (id) VALUES (?)", marker);
      throw new Error("Provider response lost after dispatch");
    }),
    calendarEventsList: query({ description: "Search events", input: object({ path: object({ calendarId: string() }), query: object({ privateExtendedProperty: json(), showDeleted: json(), maxResults: json() }) }) }, async ({ sql }, input) => {
      const filter = input.query.privateExtendedProperty;
      if (!Array.isArray(filter) || typeof filter[0] !== "string") throw new Error("Expected private property filter");
      const marker = filter[0].replace(/^vividOperation=/, "");
      return { items: sql.exec("SELECT id FROM effects WHERE id = ?", marker).toArray() };
    }),
  }),
  attempts: query({ description: "Read send attempts", input: object({}) }, async ({ sql }) => sql.exec("SELECT marker FROM attempts").toArray()),
}), { signal }) }));`,
    },
    {
      path: 'migrations/0001_effects.sql',
      content:
        'CREATE TABLE effects (id TEXT PRIMARY KEY); CREATE TABLE attempts (marker TEXT NOT NULL);',
    },
  ],
}

/** The stand-in is persisted as the curated service so the production provider adapter is selected. */
const connect = Effect.fn('ReconciliationProof.connect')(function* (actor: Actor, service: string) {
  const store = yield* ConnectionStore
  const begun = yield* store.make(actor, request)
  yield* Effect.addFinalizer(() =>
    store.remove(actor, begun.connection.id).pipe(
      Effect.result,
      Effect.map((result) => {
        expect(result._tag).toBe('Success')
      }),
    ),
  )
  yield* store.complete(actor, {
    id: begun.connection.id,
    fields: { token: Redacted.make('disposable') },
  })
  const database = yield* Database
  yield* database.run(
    database
      .update(connections)
      .set({ service: ServiceId.make(service) })
      .where(eq(connections.id, begun.connection.id)),
  )
  const row = yield* store.get(actor, begun.connection.id)
  expect(row.executorPrincipal).toBe('member')
  return row
})

/** Each unknown send goes through the real journal and lookup. Reconciliation never invokes a send. */
const scenario = Effect.fn('ReconciliationProof.scenario')(function* (input: {
  readonly actor: Actor
  readonly row: Effect.Success<ReturnType<typeof connect>>
  readonly present: boolean
}) {
  const { actor, row, present } = input
  const title = present ? 'found' : 'absent'
  const tool =
    row.service === 'google/gmail'
      ? 'gmailApi.gmailUsersMessagesSend'
      : 'calendarApi.calendarEventsInsert'
  const body: Schema.Json =
    row.service === 'google/gmail'
      ? {
          path: { userId: 'me' },
          body: {
            raw: NodeBuffer.Buffer.from(
              `To: proof@example.test\r\nSubject: ${title}\r\nMessage-ID: <original@example.test>\r\n\r\nProof`,
            ).toString('base64url'),
          },
        }
      : { path: { calendarId: 'primary' }, body: { summary: title } }
  const send = {
    connectionId: row.id,
    tool,
    input: body,
    summary: 'Send proof',
    rationale: 'Reconciliation proof',
  }
  const result = yield* useTool(actor, {
    ...send,
    toolCallId: ToolCallId.make(crypto.randomUUID()),
  })
  if (!ToolOutcome.guards.OutcomeUnknown(result.outcome) || result.outcome.receipt === null)
    return expect.fail('Expected real Executor dispatch to lose its response')
  const operationId = result.outcome.receipt.operationId
  const blocked = yield* useTool(actor, {
    ...send,
    toolCallId: ToolCallId.make(crypto.randomUUID()),
  }).pipe(Effect.flip)
  expect(blocked).toEqual(new ActionReconciliationRequired({ operationId }))
  const operations = yield* operationsOf(row)
  const before = yield* operations.call({ references: row.references, tool: 'attempts', input: {} })
  const checked = yield* reconcile(actor.person.id, operationId)
  // Gmail only ever proves a send happened; an empty search stays Inconclusive (`reconcile.ts`).
  const absent = row.service === 'google/gmail' ? 'Inconclusive' : 'NotApplied'
  expect(checked.reconciliation._tag).toBe(present ? 'Applied' : absent)
  if (ActionReconciliation.guards.Applied(checked.reconciliation))
    expect(checked.reconciliation.receipt.operationId).toBe(operationId)
  expect(
    yield* operations.call({ references: row.references, tool: 'attempts', input: {} }),
  ).toEqual(before)
  const again = yield* reconcile(actor.person.id, operationId)
  // A settled answer repeats as it is; an inconclusive one is asked again and stamped anew.
  if (ActionReconciliation.guards.Inconclusive(checked.reconciliation))
    expect(again.reconciliation._tag).toBe('Inconclusive')
  else expect(again).toEqual(checked)
})

describe.skipIf(NodeProcess.env['VIVID_LIVE_RECONCILE'] !== '1' || !testDatabaseConfigured)(
  'Provider reconciliation on Executor beta.23',
  () => {
    layer(connectionTestLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
      it.effect(
        'finds applied Gmail and Calendar sends, proves absent Calendar sends and leaves absent Gmail sends inconclusive, through their member caller',
        () =>
          Effect.gen(function* () {
            const actors = yield* fixture()
            const real = yield* Layer.build(realExecutor)
            const store = yield* Layer.build(Layer.fresh(connectionStoreLayer)).pipe(
              Effect.provide(real),
            )
            const services = Context.merge(real, store)
            const lookup = yield* Layer.build(actionLookupLayer).pipe(Effect.provide(services))
            yield* Effect.gen(function* () {
              const actor: Actor = {
                ...actors.personalActor,
                by: 'vivid',
                threadId: Option.some(actors.threadId),
              }
              for (const service of ['google/gmail', 'google/calendar']) {
                const row = yield* connect(actors.personalActor, service)
                yield* scenario({ actor, row, present: true })
                yield* scenario({ actor, row, present: false })
              }
            }).pipe(Effect.provide(services), Effect.provide(lookup))
          }).pipe(Effect.scoped),
        { timeout: 240_000 },
      )
    })
  },
)
