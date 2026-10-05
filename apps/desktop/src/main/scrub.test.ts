import type { ErrorEvent } from '@sentry/electron/main'
import { describe, expect, it } from 'vitest'
import { scrub, scrubBreadcrumb, withoutQuery } from './scrub'

/** What a Person wrote. None of it may be anywhere in a report that leaves. */
const SECRET = 'meet Ada at the old harbour'

/** A report as the SDK builds one, with the Person's words in every place the SDK can put them. */
const reported: ErrorEvent = {
  type: undefined,
  event_id: 'a3f1',
  timestamp: 1_790_000_000,
  level: 'error',
  platform: 'javascript',
  release: 'vivid-desktop@0.1.0+abc123',
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
      url: 'https://vivid.example/thread/7',
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
                filename: 'https://vivid.example/assets/index.js',
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
    expect(sent.release).toBe('vivid-desktop@0.1.0+abc123')
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

describe('the one message that may leave', () => {
  const ended: ErrorEvent = {
    type: undefined,
    level: 'fatal',
    message: "'renderer' process exited with 'crashed'",
  }

  it('keeps the sentence the SDK writes when a window ends', () => {
    expect(scrub(ended).message).toBe("'renderer' process exited with 'crashed'")
  })

  it('drops a message that only starts like it', () => {
    expect(scrub({ ...ended, message: `${ended.message}: ${SECRET}` }).message).toBeUndefined()
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

describe('withoutQuery', () => {
  it('cuts at the query or the fragment, whichever comes first', () => {
    expect(withoutQuery('/a/b?c=d#e')).toBe('/a/b')
    expect(withoutQuery('/a/b#e?c=d')).toBe('/a/b')
    expect(withoutQuery('/a/b')).toBe('/a/b')
  })
})
