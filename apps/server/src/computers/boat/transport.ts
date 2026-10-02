import { Config, Effect, Schema, type Redacted } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import {
  MachineAuthenticationFailed,
  MachineConfigurationInvalid,
  MachineOperationFailed,
  MachineRequestRejected,
  MachineResponseInvalid,
  MachineExecutionUnknown,
  type MachineKey,
} from '../machine.ts'
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

/** Select billing explicitly and persist the immutable, credential-free create body. */
const configuration = Effect.fn('Machine.boat.configuration')(
  function* () {
    const key = yield* Config.Redacted('VIVID_BOAT_API_KEY')
    const org = yield* Config.NonEmptyString('VIVID_BOAT_ORG')
    const size = yield* Config.Literals(['small', 'default', 'large'], 'VIVID_BOAT_SIZE').pipe(
      Config.withDefault('default'),
    )
    const lifetime = yield* Config.schema(
      Schema.NumberFromString.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: 0, maximum: 2592000 }),
      ),
      'VIVID_BOAT_LIFETIME_SECONDS',
    ).pipe(Config.withDefault(3600))
    const create = Protocol.CreateRequest.make({
      type: size,
      ttlSeconds: lifetime === 0 ? null : lifetime,
      noEnv: true,
      snapshots: true,
      org,
    })
    return { key, org, create }
  },
  (program) => program.pipe(Effect.mapError(() => new MachineConfigurationInvalid())),
)

/** Authenticated requests have one response boundary and bounded dispatch/body deadlines. */
const requests = (client: HttpClient.HttpClient, key: Redacted.Redacted, org: string) => {
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
            HttpClientRequest.setHeader('X-Boat-Org', org),
            HttpClientRequest.acceptJson,
          ),
        )
        .pipe(Effect.mapError(() => new MachineOperationFailed({ operation: 'transport' })))
      if (response.status < 200 || response.status >= 300) {
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
      Effect.catchTag('TimeoutError', () =>
        Effect.fail(new MachineOperationFailed({ operation: 'transport-timeout' })),
      ),
    )
}

/** API key remains Redacted until the HTTP authorization header is encoded.
 * No general retry: commands are non-idempotent, creates use durable explicit intents. */
export const transport = Effect.fn('Machine.boat.transport')(function* () {
  const client = yield* HttpClient.HttpClient
  const { key, org, create } = yield* configuration()
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
        MachineOperationFailed: () => Effect.fail(new MachineExecutionUnknown({ key: machine })),
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
