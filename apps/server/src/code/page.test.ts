import * as NodeHttp from 'node:http'
import { describe, expect, it, layer } from '@effect/vitest'
import { Context, Deferred, Effect, Fiber, Layer, Option, Predicate, Ref } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { ReadPageOutcome } from '@vivid/contracts'
import { refusalLogs } from '../observability/testlogger.ts'
import { PageResolver, publicAddress } from './address.ts'
import { PageNetwork, pageNetworkLayer, type PageResponse } from './network.ts'
import { PageReader, pageReaderLayer } from './page.ts'
import { budgets } from './budgets.ts'

const publicResolverValue = PageResolver.of({
  resolve: Effect.fn('Test.resolve')(() =>
    Effect.succeed([{ address: '93.184.215.14', family: 4 }]),
  ),
})
const publicResolver = Layer.succeed(PageResolver, publicResolverValue)
const document = (body: string): PageResponse => ({
  status: 200,
  location: Option.none(),
  contentType: 'text/html; charset=utf-8',
  body,
})

/** Public seam tests use deliberate DNS/HTTP Layers; the socket adapter is separately exercised for real. */
describe('Public pages', () => {
  /** Refusal is the page reader's successful value, not a network exception. */
  it.effect('records a page refusal once without the requested address', () => {
    const logs = refusalLogs()
    const network = Layer.succeed(
      PageNetwork,
      PageNetwork.of({
        request: () => Effect.die('A private page must never be requested'),
      }),
    )
    return Effect.gen(function* () {
      const caseContext = yield* Layer.build(
        pageReaderLayer.pipe(
          Layer.provide(Layer.merge(publicResolver, network)),
          Layer.provideMerge(logs.layer),
        ),
      )
      return yield* Effect.gen(function* () {
        const outcome = yield* (yield* PageReader).read({ address: 'http://127.0.0.1/private' })
        expect(outcome).toEqual(
          ReadPageOutcome.cases.Refused.make({ reason: 'not a public web address' }),
        )
        const recorded = logs.recorded()
        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toContain('vivid.refusal.kind=PageRefused')
        expect(recorded[0]).toContain('vivid.refusal.reason="not a public web address"')
        expect(recorded[0]).not.toContain('/private')
      }).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped)
  })

  const documentNetwork = Layer.succeed(
    PageNetwork,
    PageNetwork.of({
      request: Effect.fn('Test.document')(() =>
        Effect.succeed(
          document(
            '<html><head><title>Useful page</title></head><body><h1>Heading</h1><p>Paragraph</p><ul><li>First</li><li>Second</li></ul><a href="https://example.com/next">Next</a><script>SECRET</script></body></html>',
          ),
        ),
      ),
    }),
  )
  layer(pageReaderLayer.pipe(Layer.provide(Layer.merge(publicResolver, documentNetwork))))((it) => {
    it.effect(
      'extracts title, headings, paragraphs, lists and links and bounds readable text',
      () =>
        Effect.gen(function* () {
          const outcome = yield* (yield* PageReader).read({ address: 'https://example.com' })
          expect(ReadPageOutcome.guards.Read(outcome)).toBe(true)
          if (ReadPageOutcome.guards.Read(outcome)) {
            expect(outcome.title).toBe('Useful page')
            expect(
              outcome.text.match(
                /HEADING|Paragraph|First|Second|Next|https:\/\/example.com\/next/gu,
              ),
            ).toEqual([
              'HEADING',
              'Paragraph',
              'First',
              'Second',
              'Next',
              'https://example.com/next',
            ])
            expect(outcome.text).not.toContain('SECRET')
          }
        }).pipe(Effect.scoped),
    )
  })

  it.effect(
    'refuses credentials, non-web schemes, disguised loopback and all non-public address classes before requesting',
    () =>
      Effect.gen(function* () {
        const requests = yield* Ref.make(0)
        const network = Layer.succeed(
          PageNetwork,
          PageNetwork.of({
            request: Effect.fn('Test.mustNotFetch')(function* () {
              yield* Ref.update(requests, (value) => value + 1)
              return document('must not be reached')
            }),
          }),
        )
        const resolver = Layer.succeed(
          PageResolver,
          PageResolver.of({
            resolve: Effect.fn('Test.private')(() =>
              Effect.succeed([{ address: '10.0.0.1', family: 4 }]),
            ),
          }),
        )
        yield* Effect.gen(function* () {
          const caseContext = yield* Layer.build(
            pageReaderLayer.pipe(Layer.provide(Layer.merge(resolver, network))),
          )
          return yield* Effect.gen(function* () {
            const reader = yield* PageReader
            for (const address of [
              'file:///etc/passwd',
              'ftp://example.com',
              'https://person:secret@example.com',
              'http://2130706433',
              'http://0177.0.0.1',
              'http://[::ffff:127.0.0.1]',
              'http://internal.example',
            ]) {
              expect(yield* reader.read({ address })).toEqual(
                ReadPageOutcome.cases.Refused.make({ reason: 'not a public web address' }),
              )
            }
          }).pipe(Effect.provide(caseContext))
        }).pipe(Effect.scoped)
        expect(yield* Ref.get(requests)).toBe(0)
        for (const ip of [
          '0.0.0.0',
          '127.0.0.1',
          '10.1.1.1',
          '172.16.0.1',
          '192.168.1.1',
          '169.254.169.254',
          '100.64.0.1',
          '192.0.2.1',
          '198.18.0.1',
          '198.51.100.1',
          '203.0.113.1',
          '224.0.0.1',
          '240.0.0.1',
          '::1',
          'fe80::1',
          'fc00::1',
          '2001:db8::1',
          '3fff::1',
          '3ffe::1',
          '64:ff9b::a00:1',
          '2002:7f00:1::1',
        ])
          expect(publicAddress(ip)).toBe(false)
      }),
  )

  it.effect(
    'rechecks every redirect including a same-host DNS change and refuses mixed DNS answers',
    () =>
      Effect.gen(function* () {
        const lookups = yield* Ref.make(0)
        const requests = yield* Ref.make(0)
        const resolver = Layer.succeed(
          PageResolver,
          PageResolver.of({
            resolve: Effect.fn('Test.rebinding')(function* () {
              const count = yield* Ref.getAndUpdate(lookups, (value) => value + 1)
              return [{ address: count === 0 ? '93.184.215.14' : '127.0.0.1', family: 4 }]
            }),
          }),
        )
        const network = Layer.succeed(
          PageNetwork,
          PageNetwork.of({
            request: Effect.fn('Test.redirect')(function* () {
              yield* Ref.update(requests, (value) => value + 1)
              return {
                status: 302,
                location: Option.some('/next'),
                contentType: 'text/html',
                body: '',
              }
            }),
          }),
        )
        const outcome = yield* Effect.gen(function* () {
          const caseContext = yield* Layer.build(
            pageReaderLayer.pipe(Layer.provide(Layer.merge(resolver, network))),
          )
          return yield* Effect.gen(function* () {
            return yield* (yield* PageReader).read({ address: 'http://example.com' })
          }).pipe(Effect.provide(caseContext))
        }).pipe(Effect.scoped)
        expect(outcome).toEqual(
          ReadPageOutcome.cases.Refused.make({ reason: 'not a public web address' }),
        )
        expect(yield* Ref.get(lookups)).toBe(2)
        expect(yield* Ref.get(requests)).toBe(1)
        const mixed = Layer.succeed(
          PageResolver,
          PageResolver.of({
            resolve: Effect.fn('Test.mixedDns')(() =>
              Effect.succeed([
                { address: '93.184.215.14', family: 4 },
                { address: '10.0.0.1', family: 4 },
              ]),
            ),
          }),
        )
        yield* Effect.gen(function* () {
          const caseContext = yield* Layer.build(
            pageReaderLayer.pipe(Layer.provide(Layer.merge(mixed, network))),
          )
          return yield* Effect.gen(function* () {
            expect(yield* (yield* PageReader).read({ address: 'https://example.com' })).toEqual(
              ReadPageOutcome.cases.Refused.make({ reason: 'not a public web address' }),
            )
          }).pipe(Effect.provide(caseContext))
        }).pipe(Effect.scoped)
        expect(yield* Ref.get(requests)).toBe(1)
      }),
  )

  it.effect(
    'bounds redirect count and UTF-8 text size, and refuses non-text or oversized documents',
    () =>
      Effect.gen(function* () {
        const requests = yield* Ref.make(0)
        const network = Layer.succeed(
          PageNetwork,
          PageNetwork.of({
            request: Effect.fn('Test.redirectLoop')(function* () {
              yield* Ref.update(requests, (value) => value + 1)
              return { status: 301, location: Option.some('/again'), contentType: null, body: '' }
            }),
          }),
        )
        yield* Effect.gen(function* () {
          const caseContext = yield* Layer.build(
            pageReaderLayer.pipe(Layer.provide(Layer.merge(publicResolver, network))),
          )
          return yield* Effect.gen(function* () {
            expect(yield* (yield* PageReader).read({ address: 'https://example.com' })).toEqual(
              ReadPageOutcome.cases.Refused.make({ reason: 'could not be reached' }),
            )
          }).pipe(Effect.provide(caseContext))
        }).pipe(Effect.scoped)
        expect(yield* Ref.get(requests)).toBe(budgets.redirects + 1)
        for (const [response, expected] of [
          [document('é'.repeat(24_576)), 'Read'],
          [
            { status: 200, location: Option.none(), contentType: 'image/png', body: 'image' },
            'Refused',
          ],
          [document('x'.repeat(524_289)), 'Refused'],
        ] as const) {
          const current = PageNetwork.of({
            request: Effect.fn('Test.pageSize')(() => Effect.succeed(response)),
          })
          yield* Effect.gen(function* () {
            const outcome = yield* (yield* PageReader).read({ address: 'https://example.com' })
            expect(outcome._tag).toBe(expected)
            if (ReadPageOutcome.guards.Read(outcome)) {
              expect(Buffer.byteLength(outcome.text)).toBeLessThanOrEqual(budgets.pageText)
              expect(outcome.truncated).toBe(true)
            } else expect(outcome.reason).toBe('not a readable page')
          }).pipe(
            Effect.provideServiceEffect(
              PageReader,
              Layer.build(Layer.fresh(pageReaderLayer)).pipe(
                Effect.map((context) => Context.get(context, PageReader)),
                Effect.provideService(PageNetwork, current),
                Effect.provideService(PageResolver, publicResolverValue),
              ),
            ),
            Effect.scoped,
          )
        }
      }),
  )

  it.effect('its independent deadline includes DNS resolution', () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const resolver = Layer.succeed(
        PageResolver,
        PageResolver.of({
          resolve: Effect.fn('Test.stalledDns')(function* () {
            yield* Deferred.succeed(entered, undefined)
            return yield* Effect.never
          }),
        }),
      )
      const network = Layer.succeed(
        PageNetwork,
        PageNetwork.of({
          request: Effect.fn('Test.unreached')(() => Effect.succeed(document('unreached'))),
        }),
      )
      const running = yield* Effect.forkChild(
        Effect.gen(function* () {
          const caseContext = yield* Layer.build(
            pageReaderLayer.pipe(Layer.provide(Layer.merge(resolver, network))),
          )
          return yield* Effect.gen(function* () {
            return yield* (yield* PageReader).read({ address: 'https://example.com' })
          }).pipe(Effect.provide(caseContext))
        }).pipe(Effect.scoped),
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust('9999 millis')
      expect(running.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust('1 millis')
      expect(yield* Fiber.join(running)).toEqual(
        ReadPageOutcome.cases.Refused.make({ reason: 'could not be reached' }),
      )
    }),
  )

  layer(pageNetworkLayer)((it) => {
    it.effect(
      'pins the actual Node socket to the supplied IP, keeps Host, bounds body bytes and closes requests',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const socketClosed = yield* Deferred.make<void>()
            const server = NodeHttp.createServer((request, response) => {
              if (request.url === '/large')
                request.socket.once('close', () => Deferred.doneUnsafe(socketClosed, Effect.void))
              response.setHeader('Content-Type', 'text/plain')
              if (request.url === '/large') {
                // Leave the response open: only the reader's size refusal can close this socket.
                response.write('x'.repeat(524_289))
                return
              }
              response.end(request.headers.host)
            })
            yield* Effect.acquireRelease(
              Effect.callback<void>((resume) => {
                server.listen(0, '127.0.0.1', () => resume(Effect.void))
                server.on('error', () => resume(Effect.die('Test server could not start')))
              }),
              () =>
                Effect.callback<void>((resume) => {
                  server.closeAllConnections()
                  server.close(() => resume(Effect.void))
                }),
            )
            const address = server.address()
            if (address === null || Predicate.isString(address))
              return yield* Effect.die('Missing test listener')
            const network = yield* PageNetwork
            const url = new URL(`http://never-resolve.invalid:${address.port}/`)
            const response = yield* network.request(url, { address: '127.0.0.1', family: 4 })
            expect(response.body).toBe(url.host)
            const refused = yield* network
              .request(new URL('/large', url), { address: '127.0.0.1', family: 4 })
              .pipe(Effect.flip)
            expect(refused.reason).toBe('not a readable page')
            yield* Deferred.await(socketClosed)
            return yield* Effect.void
          }),
        ).pipe(Effect.scoped),
    )
  })
})
