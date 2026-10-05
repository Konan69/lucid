import { Effect, Function, Option, Schema, type Redacted } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import {
  MachineAuthenticationFailed,
  MachineRequestRejected,
  MachineResponseInvalid,
  MachineExecutionUnknown,
  MachineUnreachable,
  type MachineKey,
} from '../machine.ts'
import { optionalSetting, requiredSetting, settingSecret, settingText } from '../../config.ts'
import * as Protocol from './protocol.ts'

const Request = Schema.TaggedUnion({
  Get: { path: Schema.String },
  Post: { path: Schema.String, body: Schema.Json },
  Put: { path: Schema.String, body: Schema.Json },
  Create: { intent: Schema.String, body: Schema.Json },
})
type Request = typeof Request.Type
const jsonBody = HttpClientRequest.schemaBodyJson(Schema.Json)
const decodeError = HttpClientResponse.schemaBodyJson(Protocol.ErrorReply)

/**
 * Says who pays, and persists the immutable, credential-free create body.
 *
 * Boat is Vivid's Computer provider and a server does not run without it: the API key and the
 * prepared template are required here, while the server is composed, and a missing or malformed
 * one stops launch with the variable named (`requiredSetting`). There is no "no provider" server.
 * After launch the only way the Computer is missing is Boat itself not answering, which is a typed
 * failure on the call that met it (`MachineUnreachable`, a 5xx `MachineRequestRejected`).
 *
 * `VIVID_BOAT_ORG` names an organization's wallet. It is optional because a Boat account need not
 * belong to one: without it every request is billed to the account that owns the API key. Set it
 * whenever the key's account is in an organization, since Boat otherwise follows that account's
 * active wallet, which someone can change from the dashboard.
 */
export const boatConfiguration = Effect.fn('Machine.boat.configuration')(function* () {
  const key = yield* requiredSetting('VIVID_BOAT_API_KEY', settingSecret, 'the Boat API key')
  const org = yield* optionalSetting('VIVID_BOAT_ORG', settingText, 'a Boat organization')
  const template = yield* requiredSetting(
    'VIVID_BOAT_TEMPLATE',
    Protocol.TemplateName,
    'the name of the prepared Boat template',
  )
  const size = yield* optionalSetting(
    'VIVID_BOAT_SIZE',
    Schema.Literals(['small', 'default', 'large']),
    'small, default or large',
  )
  const lifetime = yield* optionalSetting(
    'VIVID_BOAT_LIFETIME_SECONDS',
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 2592000 }),
    ),
    'whole seconds from 0 to 2592000',
  )
  const seconds = Option.getOrElse(lifetime, () => 3600)
  const machine = {
    type: Option.getOrElse(size, () => 'default' as const),
    ttlSeconds: seconds === 0 ? null : seconds,
    noEnv: true,
    snapshots: true,
    from: template,
  } as const
  const create = Option.match(org, {
    onNone: () => Protocol.CreateRequest.make(machine),
    onSome: (name) => Protocol.CreateRequest.make({ ...machine, org: name }),
  })
  // An installation that already has its machine names it here, and a Person's Computer is
  // that machine instead of a new one. Boat's trial account refuses to create machines once
  // its free hours are used, while it still resumes one that exists (seen 4 October 2026:
  // create answered `trial_compute_limit_reached`, resume of the prepared machine answered
  // 202). This is for one Person: the first owner keeps the machine; other accounts are refused.
  const adopt = yield* optionalSetting(
    'VIVID_BOAT_MACHINE',
    Protocol.ProviderId,
    'a Boat machine id',
  )
  return { key, org, create, adopt }
})

/** Authenticated requests have one response boundary and bounded dispatch/body deadlines. */
const requests = (
  client: HttpClient.HttpClient,
  key: Redacted.Redacted,
  org: Option.Option<string>,
) => {
  /** Names the paying organization on every request, or leaves it to the key's own account. */
  const billed = Option.match(org, {
    onNone: () => Function.identity<HttpClientRequest.HttpClientRequest>,
    onSome: (name) => HttpClientRequest.setHeader('X-Boat-Org', name),
  })
  /** Each decoder is compiled at its ingress; only bounded status survives a refusal. */
  return <A>(input: Request, schema: Schema.ConstraintDecoder<A>) =>
    Effect.gen(function* () {
      const raw = Request.match(input, {
        Get: ({ path }) => Effect.succeed(HttpClientRequest.get(path)),
        Post: ({ path, body }) => jsonBody(HttpClientRequest.post(path), body),
        Put: ({ path, body }) => jsonBody(HttpClientRequest.put(path), body),
        Create: ({ intent, body }) =>
          jsonBody(
            HttpClientRequest.post('/sandboxes').pipe(
              HttpClientRequest.setHeader('Idempotency-Key', intent),
            ),
            body,
          ),
      })
      const outgoing = yield* raw.pipe(
        Effect.mapError(() => new MachineResponseInvalid({ operation: 'encode' })),
      )
      const response = yield* client
        .execute(
          outgoing.pipe(
            HttpClientRequest.prependUrl('https://boat.dev/api/v1'),
            HttpClientRequest.bearerToken(key),
            billed,
            HttpClientRequest.acceptJson,
            // The real proof encountered a blackholed pooled TLS socket while fresh Boat CLI
            // connections worked. Close each HTTP/1 connection through the public protocol:
            // never retry an uncertain command to repair a transport, or patch the SDK's pool.
            HttpClientRequest.setHeader('Connection', 'close'),
          ),
        )
        .pipe(Effect.mapError(() => new MachineUnreachable()))
      if (response.status < 200 || response.status >= 300) {
        // A 5xx is the provider failing, and its body is whatever an edge in front of it sent:
        // HTML, nothing, half a document. The status alone says it is an outage, so it is
        // classified before the body is read; decoding first turned such an answer into an
        // invalid response, which is recorded as the machine's state where an outage is not.
        if (response.status >= 500)
          return yield* Effect.fail(new MachineRequestRejected({ status: response.status }))
        yield* decodeError(response).pipe(
          Effect.mapError(() => new MachineResponseInvalid({ operation: 'error' })),
        )
        if (response.status === 401 || response.status === 403)
          return yield* Effect.fail(new MachineAuthenticationFailed())
        return yield* Effect.fail(new MachineRequestRejected({ status: response.status }))
      }
      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(() => new MachineResponseInvalid({ operation: 'response' })),
      )
    }).pipe(
      Effect.timeout(
        Request.guards.Post(input) && input.path.endsWith('/commands')
          ? '11 minutes'
          : '60 seconds',
      ),
      Effect.catchTag('TimeoutError', () => Effect.fail(new MachineUnreachable())),
    )
}

/** API key remains Redacted until the HTTP authorization header is encoded.
 * No general retry: commands are non-idempotent, creates use durable explicit intents. */
export const transport = Effect.fn('Machine.boat.transport')(function* () {
  const client = yield* HttpClient.HttpClient
  const { key, org, create, adopt } = yield* boatConfiguration()
  const request = requests(client, key, org)
  /** The command receipt is uncertain on transport loss, a malformed receipt, or Boat's direct-execution 5xx.
   * Never rerun user input automatically, including a desktop action. */
  const command = Effect.fn('Machine.boat.command')(function* (
    id: Protocol.ProviderId,
    machine: MachineKey,
    script: string,
    timeoutSeconds: number,
  ) {
    return yield* request(
      Request.cases.Post.make({
        path: `/sandboxes/${id}/commands`,
        body: { command: script, timeoutSeconds, detached: false, stream: false },
      }),
      Protocol.Command,
    ).pipe(
      Effect.catchTags({
        MachineUnreachable: () => Effect.fail(new MachineExecutionUnknown({ key: machine })),
        MachineResponseInvalid: () => Effect.fail(new MachineExecutionUnknown({ key: machine })),
        MachineRequestRejected: (error) =>
          error.status >= 500
            ? Effect.fail(new MachineExecutionUnknown({ key: machine }))
            : Effect.fail(error),
      }),
    )
  })
  return {
    create,
    /** The existing machine this installation uses, when it names one. */
    adopt,
    get: Effect.fn('Machine.boat.get')(function* (id: Protocol.ProviderId) {
      const reply = yield* request(
        Request.cases.Get.make({ path: `/sandboxes/${id}` }),
        Protocol.Info,
      )
      if (reply.sandbox.id !== id)
        return yield* Effect.fail(new MachineResponseInvalid({ operation: 'machine-identity' }))
      return reply
    }),
    createMachine: Effect.fn('Machine.boat.create')(
      (body: Protocol.CreateRequest, intent: string) =>
        request(Request.cases.Create.make({ intent, body }), Protocol.Created),
    ),
    transition: Effect.fn('Machine.boat.transition')(
      (id: Protocol.ProviderId, operation: 'stop' | 'resume') =>
        request(
          Request.cases.Post.make({
            path: `/sandboxes/${id}/${operation}`,
            body:
              operation === 'stop'
                ? { force: false }
                : { ttlSeconds: create.ttlSeconds, noEnv: true },
          }),
          Protocol.Transition,
        ),
    ),
    viewer: Effect.fn('Machine.boat.viewer')((id: Protocol.ProviderId) =>
      request(
        Request.cases.Post.make({
          path: `/sandboxes/${id}/desktop`,
          body: { publicAccess: false },
        }),
        Protocol.Desktop,
      ),
    ),
    read: Effect.fn('Machine.boat.read')((id: Protocol.ProviderId, path: string) =>
      request(
        Request.cases.Get.make({
          path: `/sandboxes/${id}/files?path=${encodeURIComponent(path)}&encoding=base64`,
        }),
        Protocol.ReadFile,
      ),
    ),
    write: Effect.fn('Machine.boat.write')(
      (id: Protocol.ProviderId, path: string, content: string) =>
        request(
          Request.cases.Put.make({
            path: `/sandboxes/${id}/files`,
            body: { path, content, encoding: 'utf8' },
          }),
          Protocol.Written,
        ),
    ),
    command,
  }
})
export type Transport = Effect.Success<ReturnType<typeof transport>>
