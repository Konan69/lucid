import type { Envelope, ErrorEvent, Transport } from '@sentry/core'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { guarded, outbound, place, scrub, scrubBreadcrumb } from './scrub'

/** What a Person wrote. None of it may be anywhere in a report that leaves. */
const SECRET = 'meet Ada at the old harbour'

/** A report as the SDK builds one, with the Person's words in every place the SDK can put them. */
const reported: ErrorEvent = {
  type: undefined,
  event_id: 'a3f1',
  timestamp: 1_790_000_000,
  level: 'error',
  platform: 'javascript',
  release: 'vivid-web@0.0.0+abc123',
  environment: 'production',
  message: SECRET,
  logentry: { message: SECRET },
  transaction: `/thread/${SECRET}`,
  server_name: SECRET,
  user: { id: 'person-1', email: 'ada@example.com', username: 'Ada', ip_address: '10.0.0.7' },
  extra: { draft: SECRET },
  request: {
    url: `https://vivid.example/thread/7?q=${SECRET}#${SECRET}`,
    data: { text: SECRET },
    cookies: { session: SECRET },
    query_string: `q=${SECRET}`,
    headers: { 'User-Agent': 'Mozilla/5.0', Cookie: SECRET, Referer: `https://x/?q=${SECRET}` },
  },
  tags: { 'event.process': 'renderer', thread: SECRET },
  contexts: {
    os: { name: 'iOS', version: '19.1' },
    device: { model: 'iPhone17,1', name: SECRET },
    state: { state: { type: 'redux', value: { draft: SECRET } } },
  },
  exception: {
    values: [
      {
        type: 'SchemaError',
        value: `Expected string, got "${SECRET}"`,
        mechanism: { type: 'generic', handled: true, data: { note: SECRET } },
        stacktrace: {
          frames: [
            {
              filename: `https://vivid.example/assets/index.js?v=${SECRET}`,
              function: 'decode',
              lineno: 12,
              colno: 40,
              in_app: true,
              context_line: SECRET,
              pre_context: [SECRET],
              post_context: [SECRET],
              vars: { input: SECRET },
            },
          ],
        },
      },
    ],
  },
  breadcrumbs: [
    { category: 'console', level: 'log', message: SECRET, data: { arguments: [SECRET] } },
    { category: 'ui.click', message: `button[aria-label="${SECRET}"]` },
    {
      category: 'fetch',
      type: 'http',
      data: {
        method: 'POST',
        status_code: 500,
        url: `/api/threads/7/messages?text=${SECRET}`,
        'url.query': SECRET,
        request_body_size: 31,
      },
    },
    { category: 'navigation', data: { from: `/a?x=${SECRET}`, to: `/b#${SECRET}` } },
  ],
}

describe('scrub', () => {
  const sent = scrub(reported)

  it('lets nothing a Person wrote leave, wherever the SDK had put it', () => {
    const wire = JSON.stringify(sent)
    expect(wire).not.toContain(SECRET)
    expect(wire).not.toContain('ada@example.com')
    expect(wire).not.toContain('10.0.0.7')
  })

  it('drops the user, the extras, the message and the request body, cookies and headers', () => {
    expect(sent.user).toBeUndefined()
    expect(sent.extra).toBeUndefined()
    expect(sent.message).toBeUndefined()
    expect(sent.logentry).toBeUndefined()
    expect(sent.request).toEqual({
      url: '/thread/7',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
  })

  it('keeps the kind of error and where it happened', () => {
    expect(sent.exception).toEqual({
      values: [
        {
          type: 'SchemaError',
          mechanism: { type: 'generic', handled: true },
          stacktrace: {
            frames: [
              {
                filename: '/assets/index.js',
                function: 'decode',
                lineno: 12,
                colno: 40,
                in_app: true,
              },
            ],
          },
        },
      ],
    })
  })

  it('keeps which build and which system it happened on', () => {
    expect(sent.release).toBe('vivid-web@0.0.0+abc123')
    expect(sent.environment).toBe('production')
    expect(sent.platform).toBe('javascript')
    expect(sent.tags).toEqual({ 'event.process': 'renderer' })
    expect(sent.contexts).toEqual({
      os: { name: 'iOS', version: '19.1' },
      device: { model: 'iPhone17,1' },
    })
  })

  it('keeps a request and a move between screens, without their queries, and no other breadcrumb', () => {
    expect(sent.breadcrumbs).toEqual([
      {
        category: 'fetch',
        type: 'http',
        data: { method: 'POST', status_code: 500, url: '/api/threads/7/messages' },
      },
      { category: 'navigation', data: { from: '/a', to: '/b' } },
    ])
  })
})

describe('scrubBreadcrumb', () => {
  it('drops a console line whole', () => {
    expect(scrubBreadcrumb({ category: 'console', message: SECRET })).toBeNull()
  })

  it('cuts the query from an xhr address', () => {
    expect(
      scrubBreadcrumb({ category: 'xhr', data: { method: 'GET', url: `/api/x?q=${SECRET}` } }),
    ).toEqual({ category: 'xhr', data: { method: 'GET', url: '/api/x' } })
  })
})

describe('place', () => {
  it('cuts at the query or the fragment, whichever comes first', () => {
    expect(place('/a/b?c=d#e')).toBe('/a/b')
    expect(place('/a/b#e?c=d')).toBe('/a/b')
    expect(place('/a/b')).toBe('/a/b')
  })

  it('cuts the scheme, the credentials and the host from an address', () => {
    expect(place('https://ada:pw@vivid.example:8443/thread/7?x=1')).toBe('/thread/7')
    expect(place('app:///index.android.bundle')).toBe('/index.android.bundle')
  })

  it('leaves a name that is not a path as it is', () => {
    expect(place('node:internal/process/task_queues')).toBe('node:internal/process/task_queues')
    expect(place('com.facebook.react.bridge.JavaModuleWrapper')).toBe(
      'com.facebook.react.bridge.JavaModuleWrapper',
    )
  })
})

describe('what names a Person or their machine', () => {
  /** A report whose only content is the three places a name or a query had been getting through. */
  const named: ErrorEvent = {
    type: undefined,
    fingerprint: ['{{ default }}', 'ada@example.com'],
    debug_meta: {
      images: [
        {
          type: 'sourcemap',
          debug_id: 'c0ffee00-0000-4000-8000-000000000001',
          code_file: `https://ada:pw@vivid.example/assets/index.js?draft=${SECRET}#${SECRET}`,
        },
        {
          type: 'macho',
          debug_id: 'c0ffee00-0000-4000-8000-000000000002',
          image_addr: '0x100000000',
          code_file: '/Users/ada/Library/Developer/Vivid.app/Frameworks/hermes.framework/hermes',
        },
      ],
    },
    exception: {
      values: [
        {
          type: 'Error',
          stacktrace: {
            frames: [
              {
                filename:
                  '/Users/ada/Applications/Vivid.app/Contents/Resources/app.asar/dist/main/main.cjs',
                abs_path: 'file:///home/ada/vivid/dist/main/main.cjs',
                module:
                  'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\vivid\\resources\\app.asar\\dist\\main\\main',
                function: 'boot',
              },
              {
                filename: `https://ada:pw@vivid.example/assets/index.js?draft=${SECRET}`,
                abs_path: '/var/mobile/Containers/Bundle/Application/1F2E/Vivid.app/main.jsbundle',
                module: '/data/user/0/work.vivid.mobile/files/.expo-internal/bundle',
              },
            ],
          },
        },
      ],
    },
  }
  const sent = scrub(named)
  const wire = JSON.stringify(sent)

  it('drops a fingerprint that is not the SDK default', () => {
    expect(sent.fingerprint).toBeUndefined()
    expect(wire).not.toContain('ada@example.com')
    expect(scrub({ type: undefined, fingerprint: ['{{ default }}'] }).fingerprint).toEqual([
      '{{ default }}',
    ])
  })

  it('rebuilds the debug images from their kind, their id and where the file is in the app', () => {
    expect(sent.debug_meta).toEqual({
      images: [
        {
          type: 'sourcemap',
          debug_id: 'c0ffee00-0000-4000-8000-000000000001',
          code_file: '/assets/index.js',
        },
        {
          type: 'macho',
          debug_id: 'c0ffee00-0000-4000-8000-000000000002',
          image_addr: '0x100000000',
          code_file: 'Frameworks/hermes.framework/hermes',
        },
      ],
    })
  })

  it('names every frame by its place in the app, never by whose machine it is on', () => {
    expect(wire).not.toMatch(/ada|lovelace|vivid\.example|Users|home/iu)
    expect(sent.exception).toEqual({
      values: [
        {
          type: 'Error',
          stacktrace: {
            frames: [
              {
                filename: 'dist/main/main.cjs',
                abs_path: 'vivid/dist/main/main.cjs',
                module: 'dist/main/main',
                function: 'boot',
              },
              {
                filename: '/assets/index.js',
                abs_path: 'main.jsbundle',
                module: 'files/.expo-internal/bundle',
              },
            ],
          },
        },
      ],
    })
  })
})

describe('what reaches the transport', () => {
  const sentAt = '2026-10-05T10:00:00.000Z'
  /** An envelope as the SDK builds one for a report that had a screenshot attached after `beforeSend`. */
  const withAttachment: Envelope = [
    {
      event_id: 'a3f1',
      sent_at: sentAt,
      dsn: 'https://key@o1.ingest.sentry.io/2',
      trace: { trace_id: 't1', public_key: 'key', transaction: `/thread/${SECRET}` },
    },
    [
      [{ type: 'event' }, reported],
      [{ type: 'attachment', length: SECRET.length, filename: 'screenshot.png' }, SECRET],
    ],
  ]

  it('keeps the report, scrubbed again, and drops what rides beside it', () => {
    const kept = Option.getOrThrow(outbound(withAttachment))
    expect(kept[1].map(([header]) => header.type)).toEqual(['event'])
    expect(kept[0]).toEqual({
      event_id: 'a3f1',
      sent_at: sentAt,
      dsn: 'https://key@o1.ingest.sentry.io/2',
    })
    expect(JSON.stringify(kept)).not.toContain(SECRET)
  })

  it('lets through nothing that is not an error report', () => {
    const others: ReadonlyArray<Envelope> = [
      [
        { sent_at: sentAt },
        [
          [
            { type: 'session' },
            { sid: 's1', init: true, started: sentAt, timestamp: sentAt, status: 'ok', errors: 0 },
          ],
        ],
      ],
      [{}, [[{ type: 'client_report' }, { timestamp: 1, discarded_events: [] }]]],
      [
        { event_id: 'b1', sent_at: sentAt },
        [[{ type: 'transaction' }, { type: 'transaction', transaction: SECRET }]],
      ],
      [
        { event_id: 'b2', sent_at: sentAt },
        [[{ type: 'feedback' }, { type: 'feedback', contexts: { feedback: { message: SECRET } } }]],
      ],
      [{}, [[{ type: 'check_in' }, { check_in_id: 'c1', monitor_slug: 'm', status: 'ok' }]]],
    ]
    for (const envelope of others) expect(Option.isNone(outbound(envelope))).toBe(true)
  })

  it('hands the inner transport only what is allowed, and answers the rest as sent', () => {
    const seen: Array<Envelope> = []
    const inner: Transport = {
      send: (envelope) => {
        seen.push(envelope)
        return Promise.resolve({ statusCode: 200 })
      },
      flush: () => Promise.resolve(true),
    }
    const transport = guarded(inner)
    // A transport answers with a Promise, so the test is that chain, handed to the runner.
    return transport
      .send([
        { sent_at: sentAt },
        [[{ type: 'client_report' }, { timestamp: 1, discarded_events: [] }]],
      ])
      .then((withheld) => {
        expect(withheld).toEqual({})
        expect(seen).toEqual([])
        return transport.send(withAttachment)
      })
      .then((sent) => {
        expect(sent).toEqual({ statusCode: 200 })
        expect(seen).toHaveLength(1)
        expect(JSON.stringify(seen)).not.toContain(SECRET)
        expect(JSON.stringify(seen)).not.toContain('screenshot.png')
      })
  })
})
