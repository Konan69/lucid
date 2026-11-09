import * as NodeCrypto from 'node:crypto'
import * as NodeHttp from 'node:http'
import { NodeHttpClient, NodeHttpServer } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import {
  ActionOperation,
  ActionPhase,
  ActionTarget,
  ConnectionId,
  ToolCallId,
  ToolOutcome,
} from '@vivid/contracts'
import { eq } from 'drizzle-orm'
import {
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Ref,
  Schema,
} from 'effect'
import { HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from 'effect/http'
import * as NetAddress from 'effect/net/NetAddress'
import { ActionLookup } from '../actions/journal.ts'
import { actions } from '../actions/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { libraryDocuments } from '../library/tables.ts'
import {
  Executor,
  ExecutorOwnerId,
  ExecutorStep,
  ExecutorReferences,
  executorLayer,
} from './executor.ts'
import { googleFiles, googleServices, gmailAttachmentSend } from './google.ts'
import { inspectMail } from './mail.ts'
import { ExecutorMembers, executorMembersLayer, operationsOf } from './members.ts'
import { actionLookupLayer } from './reconcile.ts'
import { connections } from './tables.ts'
import { ConnectionStore, connectionStoreLayer } from './store.ts'
import { ConnectionProbe, connectionTestLayer, fixture } from './testing.ts'
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
const decodeRaw = Schema.decodeUnknownSync(Schema.Struct({ raw: Schema.String }))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))
const decodeTarget = Schema.decodeUnknownEffect(ActionTarget)

/** Only Google is replaced. The real app, HTTP transport, file binding and journal execute. */
const provider = Effect.fn('GoogleFilesProof.provider')(function* () {
  const requests = yield* Ref.make<readonly { path: string; body: Buffer }[]>([])
  const server = yield* NodeHttpServer.make(() => NodeHttp.createServer(), {
    host: '0.0.0.0',
    port: Number(process.env['VIVID_TEST_GOOGLE_PORT']),
  })
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = Buffer.from(yield* request.arrayBuffer)
      yield* Ref.update(requests, (entries) => [...entries, { path: request.url, body }])
      const host = request.headers['host']
      const origin = `http://${host}`
      if (
        request.url.endsWith('/.well-known/openid-configuration') ||
        request.url.endsWith('/.well-known/oauth-authorization-server')
      )
        return HttpServerResponse.jsonUnsafe({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          jwks_uri: `${origin}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
        })
      if (request.url.includes('/.well-known/')) return HttpServerResponse.empty({ status: 404 })
      if (request.method === 'GET')
        return HttpServerResponse.jsonUnsafe({ messages: [{ id: 'sent-proof' }] })
      return HttpServerResponse.jsonUnsafe({ id: 'file-proof' })
    }),
  )
  if (!NetAddress.isInetAddress(server.address)) return expect.fail('Expected TCP stand-in')
  return { requests, origin: `http://host.docker.internal:${server.address.port}` }
})

/** Replace OAuth and provider destinations only. Inline discovery avoids a third-party spec request. */
const source = (
  service: (typeof googleServices)[number],
  origin: string,
  auth: 'key' | 'oauth',
) => {
  const mail = service.service === 'google/gmail'
  const path = mail ? '/gmail/v1/users/{userId}/messages' : '/drive/v3/files'
  const document = {
    openapi: '3.0.3',
    info: { title: 'Google proof', version: '1' },
    servers: [{ url: origin }],
    paths: {
      [path]: {
        get: {
          tags: [mail ? 'Gmail API' : 'Google Drive API'],
          operationId: mail ? 'gmail.users.messages.list' : 'drive.files.list',
          parameters: mail
            ? [
                { in: 'path', name: 'userId', required: true, schema: { type: 'string' } },
                { in: 'query', name: 'q', schema: { type: 'string' } },
                { in: 'query', name: 'includeSpamTrash', schema: { type: 'boolean' } },
                { in: 'query', name: 'maxResults', schema: { type: 'integer' } },
              ]
            : [],
          responses: {
            '200': {
              description: 'Recorded result',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  }
  if (mail)
    Object.assign(document.paths, {
      '/gmail/v1/users/{userId}/messages/send': {
        post: {
          tags: ['Gmail API'],
          operationId: 'gmail.users.messages.send',
          parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { raw: { type: 'string' } },
                  required: ['raw'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Sent',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    })
  return googleFiles(service).map((file) => {
    if (file.path === 'provider.ts' && auth === 'key')
      return {
        path: file.path,
        content: `import { defineProvider, secrets, object, string } from "apps";
export const provider = defineProvider({ name: "Google proof", hosts: [${JSON.stringify(new URL(origin).host)}], auth: { key: secrets({ label: "Key", fields: object({ access_token: string() }) }) } });`,
      }
    return {
      path: file.path,
      content: file.content
        .replace(/hosts: \[[^\]]+\]/u, `hosts: [${JSON.stringify(new URL(origin).host)}]`)
        .replaceAll('https://accounts.google.com', origin)
        .replaceAll('https://openidconnect.googleapis.com/v1/userinfo', `${origin}/userinfo`)
        .replaceAll('https://gmail.googleapis.com', origin)
        .replaceAll('https://www.googleapis.com', origin)
        .replace(
          `source: { url: ${JSON.stringify(service.definition)} }`,
          `source: { document: ${JSON.stringify(document)} }`,
        ),
    }
  })
}

const Deploy = Schema.StructWithRest(
  Schema.Struct({
    files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)
const decodeDeploy = Schema.decodeUnknownOption(Deploy)

/** Redirect only generated Google source destinations; production Begin and its member HTTP calls stay real. */
const realExecutor = (origin: string, auth: 'key' | 'oauth') => {
  const transport = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return HttpClient.mapRequestEffect(client, (request) => {
        if (request.method !== 'POST' || !request.url.endsWith('/apps/deploy'))
          return Effect.succeed(request)
        return Match.value(request.body).pipe(
          Match.tag('Uint8Array', (body) => {
            const parsed = decodeDeploy(decodeJson(new TextDecoder().decode(body.body)))
            if (Option.isNone(parsed)) return Effect.succeed(request)
            const service = googleServices.find((google) =>
              parsed.value.files.some(
                (file) =>
                  file.path === 'package.json' &&
                  file.content.includes(`vivid-${google.service.replace('/', '-')}`),
              ),
            )
            if (service === undefined) return Effect.succeed(request)
            return Effect.succeed(
              HttpClientRequest.bodyText(
                request,
                JSON.stringify({
                  ...parsed.value,
                  files: source(service, origin, auth),
                }),
                'application/json',
              ),
            )
          }),
          Match.orElse(() => Effect.succeed(request)),
        )
      })
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici))
  return Layer.mergeAll(executorLayer, executorMembersLayer).pipe(
    Layer.provideMerge(transport),
    Layer.provideMerge(settings),
  )
}

/** Begin uses the generated OAuth source and a Person's Member key, stopping before any token exchange. */
const signIn = Effect.fn('GoogleFilesProof.signIn')(function* (
  actor: import('../auth/access.ts').Actor,
  service: (typeof googleServices)[number],
) {
  const caller = yield* (yield* ExecutorMembers).caller({
    principal: 'member',
    personId: actor.person.id,
  })
  const operations = (yield* Executor).as(caller)
  const step = yield* operations.begin({
    connectionId: ConnectionId.make(crypto.randomUUID()),
    owner: ExecutorOwnerId.make(`p-${actor.person.id}`),
    subject: actor.person.id,
    service: service.service,
    label: service.name,
    returnAddress: 'https://vivid.example.test/api/connections/return',
  })
  yield* Effect.addFinalizer(() =>
    operations.remove(step.references).pipe(
      Effect.result,
      Effect.map((result) => expect(result._tag).toBe('Success')),
    ),
  )
  if (!ExecutorStep.guards.OpenSignIn(step)) return expect.fail('Expected OAuth sign-in step')
  expect(step.references.binding).toMatchObject({
    requirement: 'google',
    scope: 'user',
  })
  expect(new URL(step.address).pathname).toBe('/authorize')
  expect(ExecutorReferences.guards.GoogleSigningIn(step.references)).toBe(true)
})

/** Disposable beta.23 receives the real generated app and sends bytes to an observable HTTP host. */
describe.skipIf(!testDatabaseConfigured || process.env['VIVID_LIVE_GOOGLE_FILES'] !== '1')(
  'Google file tools',
  () => {
    layer(connectionTestLayer, { excludeTestServices: true, timeout: 240_000 })((it) => {
      it.effect(
        'binds Library bytes, gates sends, journals MIME and reconciles without sending again',
        () =>
          Effect.gen(function* () {
            const { personalActor: actor, threadId } = yield* fixture()
            const database = yield* Database
            const remote = yield* provider()
            const bytes = Buffer.from([0, 255, 13, 10, 128, 42])
            const digest = NodeCrypto.createHash('sha256').update(bytes).digest('hex')
            yield* database.run(
              database.insert(libraryDocuments).values({
                id: crypto.randomUUID(),
                personId: actor.person.id,
                companyId: null,
                name: 'report.bin',
                mimeType: 'application/octet-stream',
                size: bytes.length,
                sha256: digest,
                status: 'ready',
                bytes,
                createdAt: 1,
                updatedAt: 1,
              }),
            )
            const real = yield* Layer.build(realExecutor(remote.origin, 'key'))
            const built = yield* Layer.build(Layer.fresh(connectionStoreLayer)).pipe(
              Effect.provide(real),
            )
            const context = Context.merge(real, built)
            const store = Context.get(context, ConnectionStore)
            for (const service of googleServices.filter((item) =>
              ['google/gmail', 'google/drive'].includes(item.service),
            )) {
              const oauth = yield* Layer.build(Layer.fresh(realExecutor(remote.origin, 'oauth')))
              yield* signIn(actor, service).pipe(Effect.provide(oauth))
              const made = yield* store.make(actor, {
                name: `Google proof ${service.name}`,
                files: source(service, remote.origin, 'key').filter(
                  (file) => file.path !== 'package.json',
                ),
              })
              yield* Effect.addFinalizer(() =>
                store.remove(actor, made.connection.id).pipe(
                  Effect.result,
                  Effect.map((result) => expect(result._tag).toBe('Success')),
                ),
              )
              yield* store.complete(actor, {
                id: made.connection.id,
                fields: { access_token: Redacted.make('disposable-google-token') },
              })
              yield* database.run(
                database
                  .update(connections)
                  .set({ service: service.service })
                  .where(eq(connections.id, made.connection.id)),
              )
              const row = yield* store.get(actor, made.connection.id)
              if (!ExecutorReferences.guards.Authorized(row.references))
                return expect.fail('Expected personal account')
              expect(row.references.binding).toMatchObject({ scope: 'user' })
              expect(row.executorPrincipal).toBe('member')
              const operations = yield* operationsOf(row).pipe(Effect.provide(context))
              const tools = yield* operations.tools(row.references)
              const mail = service.service === 'google/gmail'
              const tool = mail ? gmailAttachmentSend : 'uploadFile'
              expect(tools.find((item) => item.name === tool)).toMatchObject({ effect: 'write' })
              expect(tools.map((item) => item.name)).toContain(
                mail ? 'gmailApi.gmailUsersMessagesList' : 'googleDriveApi.driveFilesList',
              )
              const file = { $file: { source: 'library', name: 'report.bin' } }
              const input: Schema.Json = mail
                ? {
                    to: ['ada@example.test'],
                    cc: ['cc@example.test'],
                    bcc: ['bcc@example.test'],
                    subject: 'Report',
                    body: 'The report is attached.',
                    attachments: [file],
                  }
                : { file, folderId: 'folder-proof' }
              const request = {
                connectionId: row.id,
                tool,
                input,
                summary: 'Transfer report',
                rationale: 'Prove exact file bytes',
                toolCallId: ToolCallId.make(crypto.randomUUID()),
              }
              const probe = yield* ConnectionProbe
              yield* Ref.set(probe.decision, 'ApprovalRequired')
              const gated = yield* useTool(actor, request).pipe(Effect.provide(context))
              expect(gated.outcome._tag).toBe('ApprovalRequired')
              expect(
                (yield* Ref.get(remote.requests)).filter((item) => item.body.length > 0),
              ).toHaveLength(mail ? 0 : 2)
              yield* Ref.set(probe.decision, 'Allowed')
              const result = yield* useTool(actor, request).pipe(Effect.provide(context))
              if (!ToolOutcome.guards.Completed(result.outcome) || result.outcome.receipt === null)
                return expect.fail(JSON.stringify(result.outcome))
              const receipt = result.outcome.receipt
              const [saved] = yield* database.run(
                database.select().from(actions).where(eq(actions.id, receipt.operationId)),
              )
              if (saved === undefined) return expect.fail('Missing action journal')
              const target = yield* decodeTarget(saved.target)
              const recorded = (yield* Ref.get(remote.requests)).findLast(
                (item) => item.body.length > 0,
              )
              if (recorded === undefined) return expect.fail('Missing provider request')
              if (mail) {
                const mime = Buffer.from(
                  decodeRaw(decodeJson(recorded.body.toString())).raw,
                  'base64url',
                ).toString()
                expect(mime).toContain('To: ada@example.test')
                expect(mime).toContain('Cc: cc@example.test')
                expect(mime).toContain('Bcc: bcc@example.test')
                expect(mime).toContain('multipart/mixed')
                expect(mime).toContain("filename*=UTF-8''report.bin")
                expect(mime).toContain(Buffer.from('The report is attached.').toString('base64'))
                const part = /Content-Disposition: attachment;[^]*?\r\n\r\n([^]*?)\r\n--/u.exec(
                  mime,
                )
                if (part === null) return expect.fail('Missing MIME attachment')
                const attachment = part[1]
                if (attachment === undefined) return expect.fail('Missing MIME attachment')
                expect(
                  NodeCrypto.createHash('sha256')
                    .update(Buffer.from(attachment, 'base64'))
                    .digest('hex'),
                ).toBe(digest)
                const marker = `vivid-${NodeCrypto.createHash('sha256').update(saved.id).digest('hex')}@actions.vivid.invalid`
                expect(mime).toContain(`Message-ID: <${marker}>`)
                if (!ActionTarget.guards.Connection(target))
                  return expect.fail('Expected Connection target')
                expect((yield* inspectMail(row, target)).map((item) => item._tag)).toEqual([
                  'MailEnvelope',
                ])
                const lookup = yield* Layer.build(actionLookupLayer).pipe(Effect.provide(context))
                const found = yield* Context.get(lookup, ActionLookup).look(
                  ActionOperation.make({
                    id: saved.id,
                    threadId,
                    runId: null,
                    approvalId: null,
                    target,
                    phase: ActionPhase.cases.Settled.make({ receipt }),
                  }),
                )
                expect(found._tag).toBe('Found')
                const searched = (yield* Ref.get(remote.requests)).at(-1)
                if (searched === undefined) return expect.fail('Missing reconciliation search')
                expect(searched.path).toContain(encodeURIComponent(`rfc822msgid:<${marker}>`))
                const rawResult = yield* useTool(actor, {
                  connectionId: row.id,
                  tool: 'gmailApi.gmailUsersMessagesSend',
                  input: {
                    path: { userId: 'me' },
                    body: {
                      raw: Buffer.from(
                        'To: raw@example.test\r\nSubject: Raw proof\r\n\r\nRaw body',
                      ).toString('base64url'),
                    },
                  },
                  summary: 'Send raw proof',
                  rationale: 'Preserve the original Gmail send',
                  toolCallId: ToolCallId.make(crypto.randomUUID()),
                }).pipe(Effect.provide(context))
                if (
                  !ToolOutcome.guards.Completed(rawResult.outcome) ||
                  rawResult.outcome.receipt === null
                )
                  return expect.fail(JSON.stringify(rawResult.outcome))
                const rawRequest = (yield* Ref.get(remote.requests)).findLast(
                  (item) => item.body.length > 0,
                )
                if (rawRequest === undefined) return expect.fail('Expected raw send request')
                const rawMime = Buffer.from(
                  decodeRaw(decodeJson(rawRequest.body.toString())).raw,
                  'base64url',
                ).toString()
                const rawMarker = NodeCrypto.createHash('sha256')
                  .update(rawResult.outcome.receipt.operationId)
                  .digest('hex')
                expect(rawMime).toContain(`Message-ID: <vivid-${rawMarker}@actions.vivid.invalid>`)
                expect(rawMime).toContain('Subject: Raw proof')
              } else {
                expect(recorded.path).toBe('/upload/drive/v3/files?uploadType=multipart')
                expect(recorded.body.includes(bytes)).toBe(true)
                expect(recorded.body.toString()).toContain('"parents":["folder-proof"]')
                expect(recorded.body.toString()).toContain('"name":"report.bin"')
              }
            }
            expect(
              (yield* Ref.get(remote.requests)).filter((item) => item.body.length > 0),
            ).toHaveLength(3)
            return undefined
          }).pipe(Effect.scoped),
        { timeout: 240_000 },
      )
    })
  },
)
