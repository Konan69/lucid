import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { ArtifactId, ToolCallId, ToolOutcome } from '@vivid/contracts'
import { ConfigProvider, Context, Effect, Layer, Redacted, Result } from 'effect'
import { NodeHttpClient } from '@effect/platform-node'
import { executorLayer } from './executor.ts'
import { executorMembersLayer } from './members.ts'
import { connectionStoreLayer } from './store.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { artifacts, artifactFiles, artifactVersions } from '../artifacts/tables.ts'
import { libraryDocuments } from '../library/tables.ts'
import { ConnectionStore } from './store.ts'
import { connectionTestLayer, fixture } from './testing.ts'
import { bindFiles, IntegrationFileUnavailable } from './files.ts'
import { useTool } from './tools.ts'

const settings = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    GOOGLE_CLIENT_ID: 'isolated-test-client',
    GOOGLE_CLIENT_SECRET: 'isolated-test-secret',
    VIVID_EXECUTOR_URL: process.env['VIVID_TEST_EXECUTOR_URL'],
    VIVID_EXECUTOR_PUBLIC_URL: process.env['VIVID_TEST_EXECUTOR_URL'],
    VIVID_EXECUTOR_KEY: process.env['VIVID_TEST_EXECUTOR_KEY'],
    VIVID_EXECUTOR_ORGANIZATION: process.env['VIVID_TEST_EXECUTOR_ORGANIZATION'],
    VIVID_EXECUTOR_OWNER_EMAIL: process.env['VIVID_TEST_EXECUTOR_OWNER_EMAIL'],
    VIVID_EXECUTOR_OWNER_PASSWORD: process.env['VIVID_TEST_EXECUTOR_OWNER_PASSWORD'],
    VIVID_EXECUTOR_SEAL_KEY: process.env['VIVID_TEST_EXECUTOR_SEAL_KEY'],
  }),
)
const realExecutor = Layer.mergeAll(executorLayer, executorMembersLayer).pipe(
  Layer.provideMerge(NodeHttpClient.layerUndici),
  Layer.provideMerge(settings),
)
const request = {
  name: 'File proof',
  files: [
    {
      path: 'index.ts',
      content: `import { query, defineApp, defineProvider, secrets, object, string, json, router, accountRouter } from "apps";
const service = defineProvider({ name: "File proof", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: service.many() } } }, async ({ user, signal }) => ({ tools: await accountRouter(user?.accounts.service ?? [], () => router({ read: query({ description: "Read a file digest", input: object({ attachment: object({ name: string(), mimeType: string(), base64: string() }) }), output: json() }, async (_context, { attachment }) => { const bytes = Uint8Array.from(atob(attachment.base64), c => c.charCodeAt(0)); const hash = await crypto.subtle.digest("SHA-256", bytes); return { name: attachment.name, mimeType: attachment.mimeType, digest: Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") }; }) }), { signal }) }));`,
    },
  ],
}

/** The same request shape exercises both byte resolution and refusals through admission. */
const call = (
  person: import('../auth/access.ts').Actor,
  connectionId: import('@vivid/contracts').ConnectionId,
  source: string,
  name: string,
) =>
  useTool(person, {
    connectionId,
    tool: 'read',
    input: { attachment: { $file: { source, name } } },
    summary: 'Read file digest',
    rationale: 'Verify exact transfer',
    toolCallId: ToolCallId.make(crypto.randomUUID()),
  })

/** SQL storage and the public Integration entry prove resolution and refusal before dispatch. */
describe.skipIf(!testDatabaseConfigured || process.env['VIVID_LIVE_LIBRARY_BYTES'] !== '1')(
  'Integration file bytes',
  () => {
    layer(connectionTestLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
      it.effect(
        'sends stored bytes by name and refuses another Person and oversized files',
        () =>
          Effect.gen(function* () {
            const { personalActor: actor, memberActor, threadId } = yield* fixture()
            const database = yield* Database
            const bytes = Buffer.from([0, 255, 13, 10, 128, 42])
            const digest = NodeCrypto.createHash('sha256').update(bytes).digest('hex')
            const id = ArtifactId.make(crypto.randomUUID())
            const metadata = {
              name: 'report.bin',
              mimeType: 'application/octet-stream',
              byteLength: bytes.length,
              sha256: digest,
            }
            yield* database.run(
              database.insert(artifacts).values({
                id,
                threadId,
                kind: 'file',
                title: 'Report',
                version: 1,
                createdAt: 1,
                updatedAt: 1,
              }),
            )
            yield* database.run(
              database.insert(artifactVersions).values({
                artifactId: id,
                number: 1,
                file: {},
                madeBy: {},
                at: 1,
              }),
            )
            yield* database.run(
              database.insert(artifactFiles).values({
                artifactId: id,
                number: 1,
                role: 'output',
                metadata,
                bytes,
              }),
            )
            yield* database.run(
              database.insert(libraryDocuments).values({
                id: crypto.randomUUID(),
                personId: actor.person.id,
                companyId: null,
                name: 'large.bin',
                mimeType: metadata.mimeType,
                size: 5 * 1024 * 1024 + 1,
                sha256: 'large-fixture',
                status: 'ready',
                bytes: Buffer.alloc(5 * 1024 * 1024 + 1),
                createdAt: 1,
                updatedAt: 1,
              }),
            )
            const real = yield* Layer.build(realExecutor)
            const built = yield* Layer.build(Layer.fresh(connectionStoreLayer)).pipe(
              Effect.provide(real),
            )
            const context = Context.merge(real, built)
            const store = Context.get(context, ConnectionStore)
            const created = yield* store.make(actor, request)
            yield* Effect.addFinalizer(() =>
              store.remove(actor, created.connection.id).pipe(Effect.orDie),
            )
            yield* store.complete(actor, {
              id: created.connection.id,
              fields: { token: Redacted.make('file-proof') },
            })
            const connection = created
            const received = yield* call(
              actor,
              connection.connection.id,
              'artifact',
              'Report',
            ).pipe(Effect.provide(context))
            if (!ToolOutcome.guards.Completed(received.outcome))
              return expect.fail(JSON.stringify(received.outcome))
            expect(received.outcome.output).toEqual({
              digest,
              name: metadata.name,
              mimeType: metadata.mimeType,
            })
            const denied = yield* bindFiles(memberActor, {
              $file: { source: 'artifact', name: 'Report' },
            }).pipe(Effect.result)
            if (!Result.isFailure(denied)) return expect.fail('Expected ownership refusal')
            expect(denied.failure).toBeInstanceOf(IntegrationFileUnavailable)
            const large = yield* call(actor, connection.connection.id, 'library', 'large.bin').pipe(
              Effect.provide(context),
            )
            expect(large.outcome._tag).toBe('Rejected')
          }).pipe(Effect.scoped),
        { timeout: 240_000 },
      )
    })
  },
)
