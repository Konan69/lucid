import { ReadPageOutcome, type ReadPageRequest } from '@vivid/contracts'
import { compile } from 'html-to-text'
import { Context, Effect, Layer, Option } from 'effect'
import { Refusal, recordRefusal } from '../observability/refusal.ts'
import { budgets, bytes } from './budgets.ts'
import { PageFailure, pageResolverLayer, pageUrl, resolvePage } from './address.ts'
import { PageNetwork, pageNetworkLayer, type PageResponse } from './network.ts'

const titleText = compile({
  baseElements: { selectors: ['title'], returnDomByDefault: false },
  wordwrap: false,
})
const readableText = compile({
  wordwrap: false,
  limits: { maxDepth: 32, maxChildNodes: 10_000 },
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: 'script', format: 'skip' },
    { selector: 'style', format: 'skip' },
  ],
})

export interface PageReaderService {
  readonly read: (request: ReadPageRequest) => Effect.Effect<ReadPageOutcome>
}

/** ReadPage has no cookies, credentials or Computer session; it reads exactly one public document. */
export class PageReader extends Context.Service<PageReader, PageReaderService>()(
  'vivid/PageReader',
) {}

/** UTF-8 truncation preserves readable characters and makes loss explicit in the public result. */
function textLimit(text: string) {
  let result = ''
  let size = 0
  for (const char of text) {
    size += bytes(char)
    if (size > budgets.pageText) break
    result += char
  }
  return { text: result, truncated: size > budgets.pageText }
}

/** HTML conversion is bounded at input and DOM traversal; an absent title is genuine empty text. */
const readDocument = Effect.fn('Code.readDocument')(function* (url: URL, response: PageResponse) {
  if (
    response.status < 200 ||
    response.status >= 300 ||
    response.contentType === null ||
    bytes(response.body) > budgets.pageBytes
  )
    return yield* Effect.fail(new PageFailure({ reason: 'not a readable page' }))
  const html = /^text\/html\b/i.test(response.contentType)
  if (!html && !/^text\/plain\b/i.test(response.contentType))
    return yield* Effect.fail(new PageFailure({ reason: 'not a readable page' }))
  const converted = yield* Effect.try({
    try: () => ({
      title: html ? titleText(response.body).slice(0, 500) : '',
      text: html ? readableText(response.body) : response.body,
    }),
    catch: () => new PageFailure({ reason: 'not a readable page' }),
  })
  const bounded = textLimit(converted.text)
  return ReadPageOutcome.cases.Read.make({ address: url.href, title: converted.title, ...bounded })
})

/** Each Location is parsed, resolved, checked and pinned again before the next request starts. */
const read = Effect.fn('Code.readPublicPage')(function* (request: ReadPageRequest) {
  const network = yield* PageNetwork
  let url = yield* pageUrl(request.address)
  for (let redirects = 0; redirects <= budgets.redirects; redirects++) {
    const destination = yield* resolvePage(url)
    const response = yield* network.request(url, destination)
    if (![301, 302, 303, 307, 308].includes(response.status))
      return yield* readDocument(url, response)
    if (Option.isNone(response.location) || redirects === budgets.redirects)
      return yield* Effect.fail(new PageFailure({ reason: 'could not be reached' }))
    const location = response.location.value
    const address = yield* Effect.try({
      try: () => new URL(location, url).href,
      catch: () => new PageFailure({ reason: 'not a public web address' }),
    })
    url = yield* pageUrl(address)
  }
  return yield* Effect.fail(new PageFailure({ reason: 'could not be reached' }))
})

/** One ten-second deadline includes all DNS, redirects and body bytes. */
export const pageReaderLayer = Layer.effect(
  PageReader,
  Effect.gen(function* () {
    const context = yield* Effect.context<PageNetwork | import('./address.ts').PageResolver>()
    return PageReader.of({
      read: Effect.fn('Code.ReadPage')((request) =>
        read(request).pipe(
          Effect.provide(context),
          Effect.timeoutOrElse({
            duration: `${budgets.pageSeconds} seconds`,
            orElse: () => Effect.fail(new PageFailure({ reason: 'could not be reached' })),
          }),
          Effect.catchTag(
            'PageFailure',
            Effect.fnUntraced(function* ({ reason }) {
              // This conversion decides the page refusal; DNS/HTTP failures alone are not outcomes.
              yield* recordRefusal(Refusal.cases.PageRefused.make({ reason }))
              return ReadPageOutcome.cases.Refused.make({ reason })
            }),
          ),
        ),
      ),
    })
  }),
)

export const publicPageLayer = pageReaderLayer.pipe(
  Layer.provide(Layer.merge(pageResolverLayer, pageNetworkLayer)),
)
