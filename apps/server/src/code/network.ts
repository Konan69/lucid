import * as NodeHttp from 'node:http'
import * as NodeHttps from 'node:https'
import { Context, Effect, Layer, Option } from 'effect'
import { budgets } from './budgets.ts'
import { PageFailure, type PageAddress } from './address.ts'

export interface PageResponse {
  readonly status: number
  readonly location: Option.Option<string>
  readonly contentType: string | null
  readonly body: string
}
export interface PageNetworkService {
  readonly request: (url: URL, destination: PageAddress) => Effect.Effect<PageResponse, PageFailure>
}

/** No pooled sockets or automatic redirects: every connection uses its already-vetted IP. */
export class PageNetwork extends Context.Service<PageNetwork, PageNetworkService>()(
  'vivid/PageNetwork',
) {}

/** Bounds raw bytes before concatenation. Compressed bodies are refused rather than decompressed. */
function receive(
  response: NodeHttp.IncomingMessage,
  resume: (effect: Effect.Effect<PageResponse, PageFailure>) => void,
) {
  const chunks: Buffer[] = []
  let size = 0
  const contentType = response.headers['content-type']
  const status = response.statusCode
  if (status === undefined) {
    resume(Effect.fail(new PageFailure({ reason: 'not a readable page' })))
    response.destroy()
    return
  }
  const encoding = response.headers['content-encoding']
  if (encoding !== undefined && encoding !== 'identity') {
    resume(Effect.fail(new PageFailure({ reason: 'not a readable page' })))
    response.destroy()
    return
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Node readable event payload is an unknown binary ingress, checked before copying.
  response.on('data', (input: unknown) => {
    if (!Buffer.isBuffer(input) || size + input.length > budgets.pageBytes) {
      resume(Effect.fail(new PageFailure({ reason: 'not a readable page' })))
      response.destroy()
      return
    }
    size += input.length
    chunks.push(input)
  })
  response.on('end', () =>
    resume(
      Effect.succeed({
        status,
        location: Option.fromUndefinedOr(response.headers.location),
        contentType: contentType === undefined ? null : contentType,
        body: Buffer.concat(chunks, size).toString('utf8'),
      }),
    ),
  )
  response.on('error', () =>
    resume(Effect.fail(new PageFailure({ reason: 'could not be reached' }))),
  )
  response.on('aborted', () =>
    resume(Effect.fail(new PageFailure({ reason: 'could not be reached' }))),
  )
}

/** The lookup callback cannot re-resolve: both TLS and HTTP use this exact immutable destination. */
export const pageNetworkLayer = Layer.succeed(
  PageNetwork,
  PageNetwork.of({
    request: Effect.fn('Code.fetchPage')((url, destination) =>
      Effect.callback<PageResponse, PageFailure>((resume) => {
        const request = (url.protocol === 'https:' ? NodeHttps : NodeHttp).request(
          url,
          {
            agent: false,
            family: destination.family,
            maxHeaderSize: 16_384,
            headers: {
              accept: 'text/html,text/plain',
              'accept-encoding': 'identity',
              'user-agent': 'Vivid/1.0',
            },
            // Node retains url.hostname as Host and TLS servername; only socket resolution is replaced.
            lookup(_hostname, _options, callback) {
              callback(null, destination.address, destination.family)
            },
          },
          (response) => receive(response, resume),
        )
        request.on('error', () =>
          resume(Effect.fail(new PageFailure({ reason: 'could not be reached' }))),
        )
        request.end()
        return Effect.sync(() => request.destroy())
      }),
    ),
  }),
)
