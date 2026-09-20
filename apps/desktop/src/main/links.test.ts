import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { InvalidDeepLink, parseVividUrl, vividUrlsFromArguments } from './links.ts'

describe('Vivid deep links', () => {
  it.effect('parses a Vivid host and path', () =>
    Effect.gen(function* () {
      expect(yield* parseVividUrl('vivid://thread/01K5')).toEqual({
        host: 'thread',
        path: '/01K5',
      })
    }),
  )

  it.effect('rejects malformed, foreign, hostless, and query-bearing links', () =>
    Effect.gen(function* () {
      const rejected = [
        'not a URL',
        'https://vivid.example/thread/01K5',
        'vivid:///01K5',
        'vivid://thread/01K5?unsafe=1',
      ]
      yield* Effect.forEach(rejected, (url) =>
        parseVividUrl(url).pipe(
          Effect.flip,
          Effect.map((error) => expect(error).toBeInstanceOf(InvalidDeepLink)),
        ),
      )
    }),
  )

  it.effect('extracts only valid activations from process arguments', () =>
    Effect.gen(function* () {
      expect(
        yield* vividUrlsFromArguments([
          '--enable-features=WaylandWindowDecorations',
          'vivid://thread/first',
          'https://example.com',
          'vivid://project/second',
        ]),
      ).toEqual([
        { host: 'thread', path: '/first' },
        { host: 'project', path: '/second' },
      ])
    }),
  )
})
