import type { Envelope, Transport } from '@sentry/core'
import { describe, expect, it } from 'vitest'
import { settings, startsIn } from './options'
import { scrub, scrubBreadcrumb } from './scrub'

/** A transport that only remembers what it was asked to send. */
const remembering = () => {
  const seen: Array<Envelope> = []
  const transport: Transport = {
    send: (envelope) => {
      seen.push(envelope)
      return Promise.resolve({})
    },
    flush: () => Promise.resolve(true),
  }
  return { seen, transport }
}

/** A report with a message, and a screenshot beside it: two things that must not be sent as they are. */
const envelope: Envelope = [
  { event_id: 'a3f1a3f1a3f1a3f1a3f1a3f1a3f1a3f1', sent_at: '2026-10-05T10:00:00.000Z' },
  [
    [{ type: 'event' }, { message: 'PRIVATE' }],
    [{ type: 'attachment', length: 7, filename: 'screenshot.png' }, 'PRIVATE'],
  ],
]

describe('where reporting starts', () => {
  it('starts nowhere outside a production build', () => {
    expect(startsIn({ production: false, shell: false, reporting: false })).toBe('Nowhere')
    expect(startsIn({ production: false, shell: true, reporting: true })).toBe('Nowhere')
  })

  it('starts in the browser for a production page with no shell around it', () => {
    expect(startsIn({ production: true, shell: false, reporting: false })).toBe('Browser')
  })

  it('starts through the shell only when the shell says it is reporting', () => {
    expect(startsIn({ production: true, shell: true, reporting: true })).toBe('Shell')
    expect(startsIn({ production: true, shell: true, reporting: false })).toBe('Nowhere')
  })
})

describe('what reporting starts with', () => {
  it('sends through the guard, whatever transport it is given', async () => {
    const { seen, transport } = remembering()
    const guardedTransport = settings(() => transport).transport({
      url: 'https://o1.ingest.us.sentry.io/api/2/envelope/',
      recordDroppedEvent: () => undefined,
    })
    await guardedTransport.send(envelope)
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen)).not.toContain('PRIVATE')
    expect(JSON.stringify(seen)).not.toContain('screenshot.png')
  })

  it('scrubs every report and every breadcrumb', () => {
    const { transport } = remembering()
    const started = settings(() => transport)
    expect(started.beforeSend).toBe(scrub)
    expect(started.beforeBreadcrumb).toBe(scrubBreadcrumb)
  })

  it('reports errors only, and collects nothing of the Person', () => {
    const { transport } = remembering()
    const started = settings(() => transport)
    expect(started.tracesSampleRate).toBe(0)
    expect(started.sendClientReports).toBe(false)
    expect(started.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    })
    expect(
      started
        .integrations([{ name: 'BrowserSession' }, { name: 'Dedupe' }])
        .map(({ name }) => name),
    ).toEqual(['Dedupe'])
  })
})
