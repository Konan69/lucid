import * as NodeDns from 'node:dns'
import * as NodeNet from 'node:net'
import { NodeHttpClient } from '@effect/platform-node'
import * as Undici from '@effect/platform-node/Undici'
import { Context, Effect, Layer, Schema, Option } from 'effect'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import type * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import * as HttpIncomingMessage from 'effect/unstable/http/HttpIncomingMessage'
import * as ByteSize from 'effect/ByteSize'
import { publicAddress as publicIp } from '../code/address.ts'
import { PageReader, publicPageLayer } from '../code/page.ts'
import { ReadPageOutcome } from '@vivid/contracts'
import { ConnectionAddressRefusal } from '@vivid/contracts'
import { ExecutorSourceUnsupported, ExecutorImportQueryUnsupported } from './source.ts'

/** Invalid addresses never carry their supplied value, which might contain a pasted credential. */
export class ConnectionAddressInvalid extends Schema.TaggedError<ConnectionAddressInvalid>()(
  'ConnectionAddressInvalid',
  { reason: ConnectionAddressRefusal },
  { title: 'Integration address refused' },
) {}
/** Transport failure is distinct from a reachable page that is not an integration. */
export class ConnectionAddressUnreachable extends Schema.TaggedError<ConnectionAddressUnreachable>()(
  'ConnectionAddressUnreachable',
  {},
  { title: 'Integration address unreachable' },
) {}

/** A credential-free import target established by probing the public endpoint. */
export const ConnectionSource = Schema.TaggedUnion({
  Mcp: { address: Schema.String, authorization: Schema.Literals(['auto', 'apiKey']) },
  OpenApi: { address: Schema.String },
})
export type ConnectionSource = typeof ConnectionSource.Type

/** Reject secret-bearing URLs and internal names before DNS or any outbound request. */
export function publicAddress(value: string) {
  const url = URL.parse(value)
  if (
    url === null ||
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    /[{}]/u.test(value)
  )
    return undefined
  const host = url.hostname
    .replace(/^\[|\]$/gu, '')
    .toLowerCase()
    .replace(/\.$/u, '')
  if (NodeNet.isIP(host) !== 0) return publicIp(host) ? url : undefined
  if (
    !host.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|localdomain|lan|home\.arpa)$/u.test(host)
  )
    return undefined
  return url
}

const invalid = () => ConnectionAddressInvalid.make({ reason: 'not a public web address' })
const Spec = Schema.Struct({
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, Schema.Json),
})
const decodeSpec = Schema.decodeUnknownOption(Schema.fromJsonString(Spec))

/** The network authority includes connect-time DNS checks; tests provide an explicit local transport. */
interface ConnectionAddressService {
  readonly inspect: (
    address: string,
  ) => Effect.Effect<
    ConnectionSource,
    | ConnectionAddressInvalid
    | ConnectionAddressUnreachable
    | ExecutorSourceUnsupported
    | ExecutorImportQueryUnsupported
  >
}
/** Public endpoint inspection owns outbound network authority independently of Executor credentials. */
export class ConnectionAddress extends Context.Service<
  ConnectionAddress,
  ConnectionAddressService
>()('vivid/ConnectionAddress') {}

const Initialized = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  result: Schema.Struct({
    protocolVersion: Schema.String,
    capabilities: Schema.Json,
    serverInfo: Schema.Json,
  }),
})
const decodeInitialized = Schema.decodeUnknownOption(Schema.fromJsonString(Initialized))

/** Match packages/catalog/src/contracts/imports.ts ImportUrl: query-bearing MCP endpoints
 * cannot be installed. Keep the exact accepted URL; do not silently strip meaningful parameters. */
const mcpSource = Effect.fn('Connections.mcpSource')(function* (
  address: URL,
  authorization: 'auto' | 'apiKey',
) {
  if (address.search.length > 0) return yield* Effect.fail(new ExecutorImportQueryUnsupported({}))
  return ConnectionSource.cases.Mcp.make({ address: address.href, authorization })
})

/** OAuth metadata selects discovery. A Bearer challenge without metadata, or a bare 401,
 * selects the static-key card; other explicit schemes remain unsupported. A 403 with no
 * challenge is a block (firewall, rate limit, login wall), not a request for a credential. */
const mcpAuthorization = Effect.fn('Connections.mcpAuthorization')(function* (
  address: URL,
  response: HttpClientResponse.HttpClientResponse,
) {
  const challenge = response.headers['www-authenticate']
  if (challenge === undefined) {
    if (response.status !== 401)
      return yield* Effect.fail(
        ConnectionAddressInvalid.make({ reason: 'not an MCP server or OpenAPI specification' }),
      )
    return yield* mcpSource(address, 'apiKey')
  }
  if (!/^Bearer(?:\s|$)/iu.test(challenge))
    return yield* Effect.fail(
      ConnectionAddressInvalid.make({
        reason: 'unsupported integration authorization or specification',
      }),
    )
  return yield* mcpSource(address, challenge.includes('resource_metadata') ? 'auto' : 'apiKey')
})

/** Preserve POST only across 307/308 redirects, rechecking every destination before dispatch. */
const readMcp = Effect.fn('Connections.readMcp')(function* (
  initial: URL,
  client: HttpClient.HttpClient,
) {
  const request = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post(initial.href).pipe(
      HttpClientRequest.setHeader('accept', 'application/json, text/event-stream'),
    ),
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'Vivid', version: '1' },
      },
    },
  ).pipe(Effect.mapError(() => ConnectionAddressUnreachable.make({})))
  let address = initial
  for (let hop = 0; hop <= 5; hop++) {
    const response = yield* client
      .execute(HttpClientRequest.setUrl(request, address.href))
      .pipe(Effect.mapError(() => ConnectionAddressUnreachable.make({})))
    if (response.status < 300 || response.status >= 400) return { address, response }
    const location = response.headers.location
    const redirected = location === undefined ? null : URL.parse(location, address.href)
    const next = redirected === null ? undefined : publicAddress(redirected.href)
    if (next === undefined) return yield* Effect.fail(invalid())
    if (![307, 308].includes(response.status))
      return yield* Effect.fail(ConnectionAddressUnreachable.make({}))
    address = next
  }
  return yield* Effect.fail(ConnectionAddressUnreachable.make({}))
})

/** Probe initializes a protocol session but never invokes a provider tool or supplies a secret. */
const probeMcp = Effect.fn('Connections.probeMcp')(function* (
  initial: URL,
  client: HttpClient.HttpClient,
) {
  const { address, response } = yield* readMcp(initial, client)
  if (response.status === 401 || response.status === 403)
    return yield* mcpAuthorization(address, response)
  if (response.status < 200 || response.status >= 300)
    return yield* Effect.fail(
      ConnectionAddressInvalid.make({ reason: 'not an MCP server or OpenAPI specification' }),
    )
  const body = yield* response.text.pipe(
    Effect.mapError(() => ConnectionAddressUnreachable.make({})),
  )
  if (!Option.isSome(decodeInitialized(body)) && !/^data:\s*\{.*"protocolVersion"/mu.test(body))
    return yield* Effect.fail(
      ConnectionAddressInvalid.make({ reason: 'not an MCP server or OpenAPI specification' }),
    )
  return yield* mcpSource(address, 'auto')
})

/** One bounded public redirect chain is shared by initial URLs and discovered specification links. */
const readAddress = Effect.fn('Connections.readAddress')(function* (
  value: string,
  client: HttpClient.HttpClient,
) {
  let address = publicAddress(value)
  for (let hop = 0; hop <= 5; hop++) {
    if (address === undefined) return yield* Effect.fail(invalid())
    const response = yield* client
      .get(address.href)
      .pipe(Effect.mapError(() => ConnectionAddressUnreachable.make({})))
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location
      if (location === undefined) return yield* Effect.fail(ConnectionAddressUnreachable.make({}))
      const redirected = URL.parse(location, address.href)
      address = redirected === null ? undefined : publicAddress(redirected.href)
      continue
    }
    return { address, response }
  }
  return yield* Effect.fail(ConnectionAddressUnreachable.make({}))
})

/** Follow only specification links actually published on a page, never guessed conventional paths. */
const specificationFromPage = Effect.fn('Connections.specificationFromPage')(function* (
  address: URL,
  client: HttpClient.HttpClient,
) {
  const page = yield* (yield* PageReader).read({ address: address.href })
  if (ReadPageOutcome.guards.Refused(page))
    return yield* Effect.fail(ConnectionAddressUnreachable.make({}))
  const links = [...new Set(page.text.match(/https?:\/\/[^\s<>"\])]+/gu) ?? [])]
    .filter((link) => /(?:openapi|swagger|\/spec(?:[/.]|$)|\.(?:json|ya?ml)$)/iu.test(link))
    .slice(0, 8)
  for (const link of links) {
    if (publicAddress(link) === undefined) continue
    const candidate = yield* readAddress(link, client).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        ConnectionAddressUnreachable: () => Effect.succeed(Option.none()),
        ConnectionAddressInvalid: () => Effect.succeed(Option.none()),
      }),
    )
    if (Option.isNone(candidate)) continue
    if (candidate.value.response.status < 200 || candidate.value.response.status >= 300) continue
    const body = yield* candidate.value.response.text.pipe(
      Effect.mapError(() => ConnectionAddressUnreachable.make({})),
    )
    if (Option.isSome(decodeSpec(body)) || /^openapi:\s*['"]?3\./mu.test(body))
      return yield* Effect.fail(new ExecutorSourceUnsupported({ source: 'OpenApi' }))
  }
  return yield* Effect.fail(
    ConnectionAddressInvalid.make({
      reason: 'documentation page has no OpenAPI specification link',
    }),
  )
})

/** Hosted import is MCP-only. Recognized specs fail during the probe, before app installation. */
const classifyResponse = Effect.fn('Connections.classifyAddress')(function* (
  address: URL,
  response: HttpClientResponse.HttpClientResponse,
  client: HttpClient.HttpClient,
) {
  // Streamable MCP can reject GET's Accept negotiation (406) while accepting initialize POST.
  if ([401, 403, 405, 406].includes(response.status)) return yield* probeMcp(address, client)
  if (response.status < 200 || response.status >= 300)
    return yield* Effect.fail(ConnectionAddressUnreachable.make({}))
  const type = response.headers['content-type']
  if (type !== undefined && type.includes('text/event-stream'))
    return yield* probeMcp(address, client)
  if (type !== undefined && type.includes('text/html'))
    return yield* specificationFromPage(address, client)
  const body = yield* response.text.pipe(
    Effect.mapError(() => ConnectionAddressUnreachable.make({})),
  )
  if (Option.isSome(decodeSpec(body)) || /^openapi:\s*['"]?3\./mu.test(body))
    return yield* Effect.fail(new ExecutorSourceUnsupported({ source: 'OpenApi' }))
  return yield* probeMcp(address, client)
})

/** Every redirect is parsed again; the production dispatcher also checks DNS at connection time. */
export const inspectAddress = Effect.fn('Connections.inspectAddress')(
  function* (value: string) {
    const client = yield* HttpClient.HttpClient
    const { address, response } = yield* readAddress(value, client)
    return yield* classifyResponse(address, response, client)
  },
  (effect) =>
    effect.pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(2))),
)

/** Refuse every DNS answer at socket creation, including rebinding and redirect destinations. */
/** DNS substitution is confined to this adapter factory; each returned address still faces policy. */
export type AddressLookup = (
  hostname: string,
  options: NodeDns.LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: NodeDns.LookupAddress[]) => void,
) => void

const checkedLookup =
  (resolve: AddressLookup): NodeNet.LookupFunction =>
  (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) return callback(error, [])
      const first = addresses[0]
      if (first === undefined || !addresses.every((entry) => publicIp(entry.address)))
        return callback(new Error('Integration destination refused'), [])
      if (options.all) return callback(null, addresses)
      return callback(null, first.address, first.family)
    })
  }

/** A dedicated dispatcher carries no Executor installation key to public endpoints. */
const destroyDispatcher = Effect.fn('Connections.destroyDispatcher')((agent: Undici.Agent) =>
  Effect.callback<void>((resume) => agent.destroy(() => resume(Effect.void))),
)

/** Inspection and page reading share public-address policy but never Executor credentials. */
export const makeConnectionAddressLayer = (resolve: AddressLookup) =>
  Layer.effect(
    ConnectionAddress,
    Effect.gen(function* () {
      const reader = yield* PageReader
      const dispatcher = yield* Effect.acquireRelease(
        Effect.sync(() => new Undici.Agent({ connect: { lookup: checkedLookup(resolve) } })),
        // Dispatcher.destroy's public callback signals that its sockets have stopped.
        destroyDispatcher,
      )
      const client = yield* NodeHttpClient.makeUndici.pipe(
        Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
      )
      return ConnectionAddress.of({
        inspect: Effect.fn('Connections.publicAddress')((address) =>
          inspectAddress(address).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provideService(PageReader, reader),
            Effect.scoped,
            Effect.timeout('15 seconds'),
            Effect.catchTag('TimeoutError', () =>
              Effect.fail(ConnectionAddressUnreachable.make({})),
            ),
          ),
        ),
      })
    }),
  ).pipe(Layer.provide(publicPageLayer))

/** Production always resolves through Node DNS; tests can supply deterministic DNS answers. */
export const connectionAddressLayer = makeConnectionAddressLayer(NodeDns.lookup)
