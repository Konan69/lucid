import * as NodeCrypto from 'node:crypto'
import { describe, expect, layer } from '@effect/vitest'
import { ArtifactId, ToolCallId } from '@vivid/contracts'
import { Effect, Ref } from 'effect'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { artifacts, artifactFiles, artifactVersions } from '../artifacts/tables.ts'
import { libraryDocuments } from '../library/tables.ts'
import { ConnectionStore } from './store.ts'
import { ConnectionProbe, connectionTestLayer, fixture, serviceId } from './testing.ts'
import { useTool } from './tools.ts'

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
describe.skipIf(!testDatabaseConfigured)('Integration file bytes', () => {
  layer(connectionTestLayer)((it) => {
    it.effect('sends stored bytes by name and refuses another Person and oversized files', () =>
      Effect.gen(function* () {
        const { personalActor: actor, memberActor, threadId } = yield* fixture()
        const database = yield* Database
        const probe = yield* ConnectionProbe
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
        const store = yield* ConnectionStore
        const connection = yield* store.begin(actor, {
          from: 'Web',
          service: serviceId,
          name: 'Files',
          shared: false,
        })
        const other = yield* store.begin(memberActor, {
          from: 'Web',
          service: serviceId,
          name: 'Files',
          shared: false,
        })
        yield* call(actor, connection.connection.id, 'artifact', 'Report')
        const inputs = yield* Ref.get(probe.inputs)
        const last = inputs.at(-1)
        if (last === undefined) return expect.fail('Expected Executor input')
        expect(last.input).toEqual({
          attachment: {
            name: metadata.name,
            mimeType: metadata.mimeType,
            base64: bytes.toString('base64'),
          },
        })
        const calls = yield* Ref.get(probe.calls)
        const denied = yield* call(memberActor, other.connection.id, 'artifact', 'Report')
        expect(denied.outcome._tag).toBe('Rejected')
        const large = yield* call(actor, connection.connection.id, 'library', 'large.bin')
        expect(large.outcome._tag).toBe('Rejected')
        expect(yield* Ref.get(probe.calls)).toBe(calls)
      }).pipe(Effect.scoped),
    )
  })
})
