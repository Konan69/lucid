import * as NodeFS from 'node:fs'
import * as NodeProcess from 'node:process'
import { NodeHttpClient } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { ConnectionId, ConnectionStep, PersonId, ServiceId } from '@vivid/contracts'
import { ConfigProvider, Config, Effect, Layer, Schema, Redacted, Option } from 'effect'
import { eq } from 'drizzle-orm'
import { executorEventsLayer } from '../watches/events.ts'
import { testDatabaseLayer } from '../database/testdb.ts'
import { Database } from '../database/client.ts'
import {
  Executor,
  ExecutorAccountId,
  ExecutorReferences,
  executorLayer,
  installationCaller,
} from './executor.ts'
import { connectionTestLayer, fixture, testMembersLayer } from './testing.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { proofAccounts } from './proof.ts'
import { connections } from './tables.ts'
import { decodeRow } from './records.ts'
import { migrateConnections, removeConnection } from './migration.ts'

const mode = NodeProcess.env['VIVID_EXECUTOR_MIGRATION']
const receiptFile = NodeProcess.env['VIVID_TEST_MIGRATION_RECEIPT']
const releaseFile = NodeProcess.env['VIVID_TEST_MIGRATION_RELEASE']
const Receipt = Schema.Struct({
  database: Schema.NonEmptyString,
  person: PersonId,
  first: ConnectionId,
  second: ConnectionId,
  pending: ConnectionId,
  originalApp: Schema.NonEmptyString,
  pendingApp: Schema.NonEmptyString,
  firstAccount: ExecutorAccountId,
  secondAccount: ExecutorAccountId,
})
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt))

// Every row here predates members, so each is the installation's and no member is made.
const configured = Layer.mergeAll(executorLayer, executorEventsLayer, testMembersLayer).pipe(
  Layer.provide(NodeHttpClient.layerUndici),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        GOOGLE_CLIENT_ID: 'isolated-test-client',
        GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
        VIVID_EXECUTOR_URL: NodeProcess.env['VIVID_TEST_EXECUTOR_URL'],
        VIVID_EXECUTOR_KEY: NodeProcess.env['VIVID_TEST_EXECUTOR_KEY'],
        VIVID_EXECUTOR_ORGANIZATION: NodeProcess.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
        VIVID_EXECUTOR_PUBLIC_ONLY: true,
      }),
    ),
  ),
)

/** A FIFO is the explicit cross-process release signal. The old process keeps its scoped
 * fixture alive while the new image and code inspect the very same PostgreSQL rows and volume.
 */
const released = (path: string) =>
  Effect.callback<void>((resume) => {
    const stream = NodeFS.createReadStream(path)
    stream.once('data', () => resume(Effect.void))
    stream.once('error', (error) => resume(Effect.die(error)))
    return Effect.sync(() => {
      stream.destroy()
    })
  })

/** The proof runner copies only this seed section into the pre-upgrade origin/main archive
 * at 1c01a1f8. All deployment, profile,
 * credential and persistence code used by seed is that archive's original Vivid implementation.
 * It never loads this branch's adapter while writing the old store.
 */
describe.skipIf(mode !== 'seed')('original Vivid migration fixture', () => {
  layer(
    configured.pipe(
      Layer.provideMerge(connectionTestLayer),
      Layer.provideMerge(NodeHttpClient.layerUndici),
    ),
    {
      excludeTestServices: true,
      timeout: 1_200_000,
    },
  )((it) => {
    it.effect(
      'retains two original shared-app selections and an unfinished key card',
      () =>
        Effect.gen(function* () {
          if (receiptFile === undefined || releaseFile === undefined)
            expect.fail('Supply fixture signals')
          const { ownerActor } = yield* fixture()
          const accounts = yield* proofAccounts({ personId: ownerActor.person.id }, [
            'first@example.test',
            'second@example.test',
          ])
          expect(accounts.first.references.app).toBe(accounts.second.references.app)
          const context = yield* Layer.build(Layer.fresh(connectionStoreLayer))
          const step = yield* Effect.flatMap(ConnectionStore, (store) =>
            store.begin(ownerActor, {
              from: 'Web',
              service: ServiceId.make('curated/github-com-mcp'),
              name: 'Pending migration',
              shared: false,
            }),
          ).pipe(Effect.provide(context))
          expect(ConnectionStep.guards.EnterKey(step)).toBe(true)
          const target = new URL(Redacted.value(yield* Config.Redacted('VIVID_TEST_DATABASE_URL')))
          const pending = yield* Effect.flatMap(ConnectionStore, (store) =>
            store.get(ownerActor, step.connection.id),
          ).pipe(Effect.provide(context))
          if (!ExecutorReferences.guards.EnteringKey(pending.references))
            expect.fail('Pending original app required')
          const receipt = Receipt.make({
            database: target.pathname.slice(1),
            person: ownerActor.person.id,
            first: accounts.first.id,
            second: accounts.second.id,
            pending: step.connection.id,
            originalApp: accounts.first.references.app,
            pendingApp: pending.references.app,
            firstAccount: accounts.first.references.account,
            secondAccount: accounts.second.references.account,
          })
          yield* Effect.sync(() =>
            NodeFS.writeFileSync(receiptFile, JSON.stringify(receipt) + '\n'),
          )
          yield* released(releaseFile)
        }).pipe(Effect.scoped),
      { timeout: 1_200_000 },
    )
  })
})

/** The seed's worker database remains disposable and alive until release. Use its name with
 * the explicitly supplied disposable server; no app environment or shared database is read.
 */
const retainedDatabase = Layer.unwrap(
  Effect.gen(function* () {
    if (receiptFile === undefined) return yield* Effect.die('Supply the original fixture receipt')
    const receipt = yield* decodeReceipt(
      yield* Effect.sync(() => NodeFS.readFileSync(receiptFile, 'utf8')),
    )
    const target = new URL(Redacted.value(yield* Config.Redacted('VIVID_TEST_DATABASE_URL')))
    target.pathname = `/${receipt.database}`
    return testDatabaseLayer.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            VIVID_TEST_DATABASE_URL: target.href,
          }),
        ),
      ),
    )
  }),
)

/** The real release deploys this server before the image. An old inventory must leave all
 * original rows and revisions intact, while the pure decoder presents a retryable state.
 */
describe.skipIf(mode !== 'waiting')('new server against original image', () => {
  layer(configured.pipe(Layer.provideMerge(retainedDatabase)), {
    excludeTestServices: true,
    timeout: 120_000,
  })((it) => {
    it.effect('preserves every original selection through the mixed-version interval', () =>
      Effect.gen(function* () {
        const database = yield* Database
        const before = yield* database.run(
          database.select().from(connections).orderBy(connections.id),
        )
        expect(before).toHaveLength(3)
        expect(yield* migrateConnections()).toBe(true)
        const after = yield* database.run(
          database.select().from(connections).orderBy(connections.id),
        )
        expect(after).toEqual(before)
        const rows = yield* Effect.forEach(after, decodeRow)
        expect(
          rows.every((row) => ExecutorReferences.guards.MigrationPending(row.references)),
        ).toBe(true)
        NodeProcess.stdout.write(
          'mixed-version reconciliation: all 3 legacy rows unchanged and pending\n',
        )
      }),
    )
  })
})

/** Verification uses this branch and the retained real rows, not a reconstructed JSON fixture.
 * Distinct account selections must stay distinct across the upstream app-copy migration.
 */
describe.skipIf(mode !== 'verify')('beta.23 persisted Connection migration', () => {
  layer(configured.pipe(Layer.provideMerge(retainedDatabase)), {
    excludeTestServices: true,
    timeout: 120_000,
  })((it) => {
    it.effect(
      'reconciles each retained selection and preserves its exact account identity',
      () =>
        Effect.gen(function* () {
          if (receiptFile === undefined) expect.fail('Supply the original fixture receipt')
          const receipt = yield* decodeReceipt(
            yield* Effect.sync(() => NodeFS.readFileSync(receiptFile, 'utf8')),
          )
          const database = yield* Database
          const executor = yield* Executor
          yield* migrateConnections()
          const targets = [
            {
              id: receipt.first,
              identity: 'first@example.test',
              other: 'second@example.test',
              account: receipt.firstAccount,
            },
            {
              id: receipt.second,
              identity: 'second@example.test',
              other: 'first@example.test',
              account: receipt.secondAccount,
            },
          ]
          const apps: string[] = []
          for (const target of targets) {
            const rows = yield* database.run(
              database.select().from(connections).where(eq(connections.id, target.id)),
            )
            const raw = rows[0]
            if (raw === undefined) expect.fail('Original Connection must still exist')
            const row = yield* decodeRow(raw)
            if (!ExecutorReferences.guards.Authorized(row.references))
              expect.fail('The original selected account must remain authorized')
            expect(row.references.account).toBe(target.account)
            expect(row.references.appOwnership._tag).toBe(
              row.references.app === receipt.originalApp ? 'Unproven' : 'Copied',
            )
            expect(row.executorApp).toBe(row.references.app)
            expect(row.personId).toBe(receipt.person)
            expect(JSON.stringify(row.references)).not.toContain('profile')
            expect((yield* executor.as(installationCaller).status(row.references))._tag).toBe(
              'Ready',
            )
            const identity = yield* executor.as(installationCaller).identity(row.references)
            expect(identity).toEqual(Option.some(target.identity))
            const subject = `migration-${target.id}`
            expect(
              (yield* executor.as(installationCaller).call({
                references: row.references,
                tool: 'save',
                input: { subject },
              }))._tag,
            ).toBe('Completed')
            const read = yield* executor.as(installationCaller).call({
              references: row.references,
              tool: 'records',
              input: { subject },
            })
            expect(read._tag).toBe('Completed')
            expect(JSON.stringify(read)).toContain(target.identity)
            expect(JSON.stringify(read)).not.toContain(target.other)
            apps.push(row.references.app)
            NodeProcess.stdout.write(
              `migration ${target.id} => ${row.references.app} ${row.references._tag}\n`,
            )
          }
          expect(new Set(apps).size).toBe(2)
          expect(apps).toContain(receipt.originalApp)
          const pending = (yield* database.run(
            database.select().from(connections).where(eq(connections.id, receipt.pending)),
          ))[0]
          if (pending === undefined) expect.fail('The unfinished original Connection must exist')
          const row = yield* decodeRow(pending)
          if (!ExecutorReferences.guards.EnteringKey(row.references))
            expect.fail('EnteringKey must survive migration')
          expect(row.references.app).toBe(receipt.pendingApp)
          expect((yield* executor.as(installationCaller).status(row.references))._tag).toBe(
            'NeedsAuthorization',
          )
          NodeProcess.stdout.write(
            `migration ${receipt.pending} => ${row.references.app} ${row.references._tag}\n`,
          )
        }),
      { timeout: 120_000 },
    )
    it.effect(
      'removing the migrated original preserves the shared app and the other account',
      () =>
        Effect.gen(function* () {
          if (receiptFile === undefined) expect.fail('Supply the original fixture receipt')
          const receipt = yield* decodeReceipt(
            yield* Effect.sync(() => NodeFS.readFileSync(receiptFile, 'utf8')),
          )
          const database = yield* Database
          const executor = yield* Executor
          const rows = yield* database.run(database.select().from(connections))
          const first = rows.find((row) => row.id === receipt.first)
          const second = rows.find((row) => row.id === receipt.second)
          if (first === undefined || second === undefined)
            expect.fail('Both migrated rows must exist')
          yield* removeConnection(yield* decodeRow(first))
          const inventory = yield* executor.inventory
          expect(inventory.apps.some((app) => app.id === receipt.originalApp)).toBe(true)
          expect(inventory.accounts.some((account) => account.id === receipt.firstAccount)).toBe(
            false,
          )
          expect(inventory.accounts.some((account) => account.id === receipt.secondAccount)).toBe(
            true,
          )
          const remaining = yield* decodeRow(second)
          expect((yield* executor.as(installationCaller).status(remaining.references))._tag).toBe(
            'Ready',
          )
          const read = yield* executor.as(installationCaller).call({
            references: remaining.references,
            tool: 'records',
            input: { subject: `migration-${receipt.second}` },
          })
          expect(read._tag).toBe('Completed')
          expect(JSON.stringify(read)).toContain('second@example.test')
          expect(JSON.stringify(read)).not.toContain('first@example.test')
          NodeProcess.stdout.write('migration shared-original removal: PASS\n')
        }),
      { timeout: 120_000 },
    )
  })
})
