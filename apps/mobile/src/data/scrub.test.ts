import type { Envelope, ErrorEvent, Transport } from '@sentry/core'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { REMOVED, file, guarded, outbound, place, scrub, scrubBreadcrumb } from './scrub'

/** What a Person wrote. None of it may be anywhere in a report that leaves. */
const SECRET = 'meet Ada at the old harbour'

/** A report as the SDK builds one, with the Person's words in every place the SDK can put them. */
const reported: ErrorEvent = {
  type: undefined,
  event_id: 'a3f1a3f1a3f1a3f1a3f1a3f1a3f1a3f1',
  timestamp: 1_790_000_000,
  level: 'error',
  platform: 'javascript',
  release: 'work.vivid.mobile@0.2.0+1',
  environment: 'production',
  message: SECRET,
  logentry: { message: SECRET },
  transaction: `/thread/${SECRET}`,
  server_name: SECRET,
  user: { id: 'person-1', email: 'ada@example.com', username: 'Ada', ip_address: '10.0.0.7' },
  extra: { draft: SECRET },
  request: {
    url: `https://vivid.example/t/7?q=${SECRET}#${SECRET}`,
    data: { text: SECRET },
    cookies: { session: SECRET },
    query_string: `q=${SECRET}`,
    headers: { 'User-Agent': 'Mozilla/5.0', Cookie: SECRET, Referer: `https://x/?q=${SECRET}` },
  },
  tags: { 'event.process': 'renderer', thread: SECRET },
  contexts: {
    os: { name: 'iOS', version: '19.1', kernel_version: SECRET },
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
              filename: `https://vivid.example/main.jsbundle?v=${SECRET}`,
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
        url: `/api/vivid/threads/7/messages?text=${SECRET}`,
        'url.query': SECRET,
        request_body_size: 31,
      },
    },
    { category: 'navigation', data: { from: `Chat?thread=${SECRET}`, to: `Ada’s thread` } },
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
    expect(sent.request).toEqual({ url: REMOVED, headers: { 'User-Agent': 'Mozilla/5.0' } })
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
                filename: 'app:///main.jsbundle',
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
    expect(sent.release).toBe('work.vivid.mobile@0.2.0+1')
    expect(sent.environment).toBe('production')
    expect(sent.platform).toBe('javascript')
    expect(sent.tags).toEqual({ 'event.process': 'renderer' })
    expect(sent.contexts).toEqual({
      os: { name: 'iOS', version: '19.1' },
      device: { model: 'iPhone17,1' },
    })
  })

  it('keeps a request and a move between screens as the app’s own routes, and no other breadcrumb', () => {
    expect(sent.breadcrumbs).toEqual([
      {
        category: 'fetch',
        type: 'http',
        data: { method: 'POST', status_code: 500, url: '/api/vivid' },
      },
      { category: 'navigation', data: { from: 'Chat', to: REMOVED } },
    ])
  })
})

describe('a path is kept only as a file of the build', () => {
  it('keeps the app’s one bundle by the name the SDK gives it on each system', () => {
    expect(file('app:///main.jsbundle')).toBe('app:///main.jsbundle')
    expect(file('app:///index.android.bundle')).toBe('app:///index.android.bundle')
    expect(file('[native code]')).toBe('[native code]')
  })

  it.each([
    ['a network share', '\\\\Ada-PC\\private\\main.js'],
    ['a folder outside the home folder', '/opt/Ada/main.js'],
    ['a path with its slashes escaped', '/Users%2FAda%2Fmain.js'],
    [
      'the bundle in someone’s folder',
      '/var/mobile/Containers/Bundle/Application/1F2E/Vivid.app/main.jsbundle',
    ],
    ['a path escaped wrongly', '/%E0%A4%A.jsbundle'],
    ['a hundred kilobytes', `/${'a'.repeat(100_000)}/main.jsbundle`],
  ])('removes %s', (_, path) => {
    expect(file(path)).toBe(REMOVED)
  })
})

describe('an address is kept only as one of the app’s screens or the server’s parts', () => {
  it('keeps a screen by its name and a request by the first part of its path', () => {
    expect(place('Chat')).toBe('Chat')
    expect(place('Settings')).toBe('Settings')
    expect(place('https://vivid.example/api/auth/sign-in/email?email=ada@example.com')).toBe(
      '/api/auth',
    )
  })

  it.each([
    ['an address the app has no route for', '/thread/ada%40example.com'],
    ['an api the server does not have', '/api/ada/private'],
    ['a screen the app does not have', 'Ada'],
    ['a hundred kilobytes', `/api/auth/${'a'.repeat(100_000)}`],
  ])('removes %s', (_, address) => {
    expect(place(address)).toBe(REMOVED)
  })
})

describe('what names a Person or their machine', () => {
  /** A report whose only content is the places a name had been getting through. */
  const named: ErrorEvent = {
    type: undefined,
    release: 'Ada Lovelace',
    dist: 'ada private',
    environment: 'Ada',
    fingerprint: ['{{ default }}', 'ada@example.com'],
    sdk: {
      name: 'sentry.javascript.react',
      version: '11.1.0',
      integrations: ['Dedupe', 'AdaSecret'],
      packages: [{ name: 'npm:@sentry/react', version: 'Ada 1' }],
      settings: { infer_ip: 'auto' },
    },
    tags: { 'event.process': 'Ada Private', 'expo.updates.channel': 'ada private' },
    contexts: {
      os: { name: 'Ada OS', version: 'ada', build: 'ada private' },
      browser: { name: 'Ada', version: '1.2.3' },
    },
    debug_meta: {
      images: [
        {
          type: 'sourcemap',
          debug_id: 'c0ffee00-0000-4000-8000-000000000001',
          code_file: `https://ada:pw@vivid.example/main.jsbundle?draft=${SECRET}#${SECRET}`,
        },
        {
          type: 'macho',
          debug_id: 'ada private',
          image_addr: 'ada',
          code_file: '/Users/ada/Library/Developer/Vivid.app/Frameworks/hermes.framework/hermes',
        },
      ],
    },
    exception: {
      values: [
        {
          type: 'Error: ada@example.com',
          module: '/Users/Ada/private',
          mechanism: { type: 'ada@example.com', source: 'ada private' },
          stacktrace: {
            frames: [
              {
                filename: '/Users/ada/Applications/Vivid.app/Contents/Resources/app.asar/x.js',
                abs_path: 'file:///home/ada/vivid/dist/main/main.cjs',
                module: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\vivid\\main',
                function: 'send("ada@example.com")',
                platform: 'ada',
                instruction_addr: 'ada',
                addr_mode: 'ada',
                debug_id: 'ada private',
              },
              { function: 'Object.<anonymous>', module: 'async App' },
              { function: '?' },
            ],
          },
        },
      ],
    },
  }
  const sent = scrub(named)
  const wire = JSON.stringify(sent)

  it('leaves no trace of the name anywhere', () => {
    expect(wire).not.toMatch(/ada|lovelace|vivid\.example|Users|home|private/iu)
  })

  it('drops a fingerprint that is not the SDK default', () => {
    expect(sent.fingerprint).toBeUndefined()
    expect(scrub({ type: undefined, fingerprint: ['{{ default }}'] }).fingerprint).toEqual([
      '{{ default }}',
    ])
  })

  it('rebuilds the debug images from their kind, their id and which file of the build they are', () => {
    expect(sent.debug_meta).toEqual({
      images: [
        {
          type: 'sourcemap',
          debug_id: 'c0ffee00-0000-4000-8000-000000000001',
          code_file: 'app:///main.jsbundle',
        },
        { type: 'macho', debug_id: REMOVED, image_addr: REMOVED, code_file: REMOVED },
      ],
    })
  })

  it('keeps a name out of code only when it is shaped like one', () => {
    expect(sent.exception).toEqual({
      values: [
        {
          type: REMOVED,
          module: REMOVED,
          mechanism: { type: REMOVED, source: REMOVED },
          stacktrace: {
            frames: [
              {
                filename: REMOVED,
                abs_path: REMOVED,
                module: REMOVED,
                function: REMOVED,
                platform: REMOVED,
                instruction_addr: REMOVED,
                addr_mode: REMOVED,
                debug_id: REMOVED,
              },
              { function: 'Object.<anonymous>', module: 'async App' },
              { function: '?' },
            ],
          },
        },
      ],
    })
  })

  it('keeps of the SDK’s account of itself only its own words, and never lets it ask for the address', () => {
    expect(sent.sdk).toEqual({
      name: 'sentry.javascript.react',
      version: '11.1.0',
      integrations: ['Dedupe'],
      packages: [{ name: 'npm:@sentry/react', version: REMOVED }],
      settings: { infer_ip: 'never' },
    })
  })

  it('keeps a tag, a context and the build’s names only by their shape', () => {
    expect(sent.release).toBe(REMOVED)
    expect(sent.dist).toBe(REMOVED)
    expect(sent.environment).toBe(REMOVED)
    expect(sent.tags).toEqual({ 'event.process': REMOVED, 'expo.updates.channel': REMOVED })
    expect(sent.contexts).toEqual({
      os: { name: REMOVED, version: REMOVED, build: REMOVED },
      browser: { name: REMOVED, version: '1.2.3' },
    })
  })
})

describe('scrubBreadcrumb', () => {
  it('drops a console line whole', () => {
    expect(scrubBreadcrumb({ category: 'console', message: SECRET })).toBeNull()
  })

  it('keeps of an xhr only its method and which route it went to', () => {
    expect(
      scrubBreadcrumb({
        category: 'xhr',
        type: SECRET,
        data: { method: SECRET, url: `/api/library/${SECRET}?q=${SECRET}` },
      }),
    ).toEqual({ category: 'xhr', type: REMOVED, data: { method: REMOVED, url: '/api/library' } })
  })
})

describe('what reaches the transport', () => {
  const sentAt = '2026-10-05T10:00:00.000Z'
  const id = 'a3f1a3f1a3f1a3f1a3f1a3f1a3f1a3f1'
  /** An envelope as the SDK builds one for a report that had a screenshot attached after `beforeSend`. */
  const withAttachment: Envelope = [
    {
      event_id: id,
      sent_at: sentAt,
      dsn: 'https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/2',
      trace: { trace_id: 't1', public_key: 'key', transaction: `/thread/${SECRET}` },
    },
    [
      [{ type: 'event' }, reported],
      [{ type: 'attachment', length: SECRET.length, filename: 'screenshot.png' }, SECRET],
    ],
  ]

  it('keeps the report, scrubbed again, and drops what rides beside it', () => {
    const allowed = Option.getOrThrow(outbound(withAttachment))
    expect(allowed[1].map(([header]) => header.type)).toEqual(['event'])
    expect(allowed[0]).toEqual({
      event_id: id,
      sent_at: sentAt,
      dsn: 'https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/2',
    })
    expect(JSON.stringify(allowed)).not.toContain(SECRET)
  })

  it('keeps a header only by its shape', () => {
    const allowed = Option.getOrThrow(
      outbound([
        { event_id: SECRET, sent_at: SECRET, dsn: SECRET },
        [[{ type: 'event' }, reported]],
      ]),
    )
    expect(allowed[0]).toEqual({ event_id: REMOVED, sent_at: REMOVED, dsn: REMOVED })
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

  it('hands the inner transport only what is allowed, and answers the rest as sent', async () => {
    const seen: Array<Envelope> = []
    const inner: Transport = {
      send: (envelope) => {
        seen.push(envelope)
        return Promise.resolve({ statusCode: 200 })
      },
      flush: () => Promise.resolve(true),
    }
    const transport = guarded(inner)
    expect(
      await transport.send([
        { sent_at: sentAt },
        [[{ type: 'client_report' }, { timestamp: 1, discarded_events: [] }]],
      ]),
    ).toEqual({})
    expect(seen).toEqual([])
    expect(await transport.send(withAttachment)).toEqual({ statusCode: 200 })
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen)).not.toContain(SECRET)
    expect(JSON.stringify(seen)).not.toContain('screenshot.png')
  })
})
