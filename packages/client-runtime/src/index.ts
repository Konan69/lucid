import { RuntimeErrorResponse } from '@vivid/contracts'
import { Effect, Schema } from 'effect'

const decodeRuntimeErrorText = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeErrorResponse),
)

/** Minimal transport request understood by the schema client. */
export interface TransportRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string | FormData
  readonly signal: AbortSignal
}

/** Minimal response surface required from an injected transport. */
export interface TransportResponse {
  readonly ok: boolean
  readonly status: number
  readonly readText: () => Promise<string>
}

/** Transport authority injected by a browser, native shell, or test. */
export interface ClientTransport {
  readonly request: (request: TransportRequest) => Promise<TransportResponse>
}

class FetchResponse implements TransportResponse {
  readonly ok: boolean
  readonly status: number

  constructor(private readonly response: Response) {
    this.ok = response.ok
    this.status = response.status
  }

  /** Reads the response body once for schema decoding. */
  readText(): Promise<string> {
    return this.response.text()
  }
}

class FetchTransport implements ClientTransport {
  constructor(private readonly fetcher: typeof fetch) {}

  /** Adapts one schema-client request to a Fetch-compatible runtime. */
  async request(request: TransportRequest): Promise<TransportResponse> {
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    })
    return new FetchResponse(response)
  }
}

/** Turns a Fetch-compatible function into the transport authority used by the client. */
export const fetchTransport = (fetcher: typeof fetch): ClientTransport =>
  new FetchTransport(fetcher)

/** Invalid local client configuration. */
export class InvalidServerAddress extends Schema.TaggedError<InvalidServerAddress>()(
  'InvalidServerAddress',
  {
    message: Schema.String,
  },
  { title: 'Invalid server address' },
) {}

/** A request value could not be encoded by its declared wire schema. */
export class RequestEncodingFailed extends Schema.TaggedError<RequestEncodingFailed>()(
  'RequestEncodingFailed',
  {
    message: Schema.String,
  },
  { title: 'Request encoding failed' },
) {}

/** The transport failed before an HTTP response was available. */
export class TransportFailed extends Schema.TaggedError<TransportFailed>()(
  'TransportFailed',
  {
    message: Schema.String,
  },
  { title: 'Transport failed' },
) {}

/** The server rejected a valid request. */
export class RequestRejected extends Schema.TaggedError<RequestRejected>()(
  'RequestRejected',
  {
    status: Schema.Number,
    message: Schema.String,
  },
  { title: 'Request rejected' },
) {}

/** The requested resource does not exist. */
export class ResourceNotFound extends Schema.TaggedError<ResourceNotFound>()(
  'ResourceNotFound',
  {
    message: Schema.String,
  },
  { title: 'Resource not found' },
) {}

/** The server failed while handling a valid request. */
export class ServerFailed extends Schema.TaggedError<ServerFailed>()(
  'ServerFailed',
  {
    status: Schema.Number,
    message: Schema.String,
  },
  { title: 'Server failed' },
) {}

/** A successful response did not match its declared wire schema. */
export class ResponseDecodingFailed extends Schema.TaggedError<ResponseDecodingFailed>()(
  'ResponseDecodingFailed',
  {
    message: Schema.String,
  },
  { title: 'Response decoding failed' },
) {}

/** Every typed failure exposed by the transport-neutral client. */
export const ClientFailure = Schema.Union([
  RequestEncodingFailed,
  TransportFailed,
  RequestRejected,
  ResourceNotFound,
  ServerFailed,
  ResponseDecodingFailed,
])
/** Decoded client failure union. */
export type ClientFailure = typeof ClientFailure.Type

/** Options shared by requests without JSON bodies. */
export interface RequestOptions {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly multipart?: FormData
}

/** Configuration required to construct one client boundary. */
export interface ClientOptions {
  readonly baseUrl: string
  readonly token?: string
  readonly timeoutMs?: number
  readonly transport: ClientTransport
}

/** One schema-owned JSON request passed through the transport boundary. */
export interface JsonRequest<Body, BodyEncoded, Response, ResponseEncoded> {
  readonly bodySchema: Schema.Codec<Body, BodyEncoded>
  readonly responseSchema: Schema.Codec<Response, ResponseEncoded>
  readonly path: string
  readonly body: Body
  readonly options?: Omit<RequestOptions, 'multipart'>
}

/** Schema-decoding client shared by browser and native adapters. */
export interface SchemaClient {
  readonly baseUrl: string
  readonly request: <Response, ResponseEncoded>(
    responseSchema: Schema.Codec<Response, ResponseEncoded>,
    path: string,
    options?: RequestOptions,
  ) => Effect.Effect<Response, ClientFailure>
  readonly requestJson: <Body, BodyEncoded, Response, ResponseEncoded>(
    request: JsonRequest<Body, BodyEncoded, Response, ResponseEncoded>,
  ) => Effect.Effect<Response, ClientFailure>
}

/** Validates and normalizes a server root without carrying credentials in its URL. */
export const normalizeServerUrl = (value: string): string => {
  const candidate = value.trim()
  if (!URL.canParse(candidate)) {
    throw new InvalidServerAddress({ message: 'Use a valid Vivid server address.' })
  }
  const url = new URL(candidate)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new InvalidServerAddress({
      message: 'Use an http or https server address without credentials or query parameters.',
    })
  }
  return url.toString().replace(/\/+$/, '')
}

/** Reads a server-owned error envelope while retaining a useful status fallback. */
const readFailureMessage = Effect.fn('SchemaClient.readFailureMessage')(function* (
  response: TransportResponse,
) {
  const payload = yield* Effect.tryPromise(() => response.readText()).pipe(Effect.option)
  if (payload._tag === 'None') {
    return `Vivid returned status ${response.status}.`
  }
  const envelope = yield* decodeRuntimeErrorText(payload.value).pipe(Effect.option)
  return envelope._tag === 'Some'
    ? envelope.value.error
    : `Vivid returned status ${response.status}.`
})

/** Maps status families to failures that callers can handle independently. */
const failResponse = Effect.fn('SchemaClient.failResponse')(function* (
  response: TransportResponse,
) {
  const message = yield* readFailureMessage(response)
  if (response.status === 404) {
    return yield* Effect.fail(new ResourceNotFound({ message }))
  }
  if (response.status >= 500) {
    return yield* Effect.fail(new ServerFailed({ status: response.status, message }))
  }
  return yield* Effect.fail(new RequestRejected({ status: response.status, message }))
})

class SchemaClientImplementation implements SchemaClient {
  readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly authorizationHeaders: Readonly<Record<string, string>>

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = normalizeServerUrl(options.baseUrl)
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.authorizationHeaders =
      options.token && options.token.length > 0 ? { authorization: `Bearer ${options.token}` } : {}
  }

  /** Decodes one response after the transport returns it. */
  private execute<Response, ResponseEncoded>(
    responseSchema: Schema.Codec<Response, ResponseEncoded>,
    path: string,
    requestOptions: RequestOptions = {},
    encodedBody?: string,
  ): Effect.Effect<Response, ClientFailure> {
    const { authorizationHeaders, baseUrl, options, timeoutMs } = this
    return Effect.fn('SchemaClient.execute')(function* () {
      const body = requestOptions.multipart ?? encodedBody
      const contentHeaders =
        encodedBody === undefined
          ? authorizationHeaders
          : { ...authorizationHeaders, 'content-type': 'application/json' }
      const headers = { ...contentHeaders, ...requestOptions.headers }
      const requestWithoutBody: TransportRequest = {
        url: `${baseUrl}${path}`,
        method: requestOptions.method ?? 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      }
      const transportRequest: TransportRequest =
        body === undefined ? requestWithoutBody : { ...requestWithoutBody, body }
      const response = yield* Effect.tryPromise(() =>
        options.transport.request(transportRequest),
      ).pipe(Effect.mapError((cause) => new TransportFailed({ message: cause.message })))
      if (!response.ok) {
        return yield* failResponse(response)
      }
      if (response.status === 204) {
        return yield* Schema.decodeUnknownEffect(responseSchema)(undefined).pipe(
          Effect.mapError((error) => new ResponseDecodingFailed({ message: error.message })),
        )
      }
      const payload = yield* Effect.tryPromise(() => response.readText()).pipe(
        Effect.mapError(
          () => new ResponseDecodingFailed({ message: 'Vivid returned an unreadable response.' }),
        ),
      )
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(responseSchema))(payload).pipe(
        Effect.mapError((error) => new ResponseDecodingFailed({ message: error.message })),
      )
    })()
  }

  /** Executes one request without a JSON body. */
  request<Response, ResponseEncoded>(
    responseSchema: Schema.Codec<Response, ResponseEncoded>,
    path: string,
    options?: RequestOptions,
  ): Effect.Effect<Response, ClientFailure> {
    return this.execute(responseSchema, path, options)
  }

  /** Encodes one request body before handing it to the transport. */
  requestJson<Body, BodyEncoded, Response, ResponseEncoded>(
    request: JsonRequest<Body, BodyEncoded, Response, ResponseEncoded>,
  ): Effect.Effect<Response, ClientFailure> {
    const { bodySchema, responseSchema, path, body, options = {} } = request
    return Schema.encodeEffect(bodySchema)(body).pipe(
      Effect.mapError((error) => new RequestEncodingFailed({ message: error.message })),
      Effect.map((encoded) => JSON.stringify(encoded)),
      Effect.flatMap((encoded) => this.execute(responseSchema, path, options, encoded)),
    )
  }
}

/** Constructs a client whose only untyped seam is its injected transport response. */
export const createSchemaClient = (options: ClientOptions): SchemaClient =>
  new SchemaClientImplementation(options)
