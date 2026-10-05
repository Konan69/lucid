import {
  makeOfflineTransport,
  type Envelope,
  type OfflineStore,
  type Transport,
} from '@sentry/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reports, settings } from './options.ts'
import { scrub, scrubBreadcrumb } from './scrub.ts'

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
const envelope = (): Envelope => [
  { event_id: 'a3f1a3f1a3f1a3f1a3f1a3f1a3f1a3f1', sent_at: '2026-10-05T10:00:00.000Z' },
  [
    [{ type: 'event' }, { message: 'PRIVATE' }],
    [{ type: 'attachment', length: 7, filename: 'screenshot.png' }, 'PRIVATE'],
  ],
]

/** What the SDK hands a transport when it makes one. */
const given = {
  url: 'https://o1.ingest.us.sentry.io/api/2/envelope/',
  recordDroppedEvent: () => undefined,
}

/** The start's settings around a transport that remembers, with a queue that only passes through. */
const started = (online: Transport) =>
  settings({
    online: () => online,
    queued: (base) => base,
    protocol: 2,
    sessions: () => [],
    ended: () => ({ name: 'ChildProcess' }),
  })

describe('whether reporting starts', () => {
  it('starts only in a packaged app', () => {
    expect(reports({ packaged: true })).toBe(true)
    expect(reports({ packaged: false })).toBe(false)
  })
})

describe('what reporting starts with', () => {
  it('sends through the guard, whatever transport it is given', async () => {
    const { seen, transport } = remembering()
    await started(transport).transport(given).send(envelope())
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen)).not.toContain('PRIVATE')
    expect(JSON.stringify(seen)).not.toContain('screenshot.png')
  })

  it('scrubs every report and every breadcrumb', () => {
    const { transport } = remembering()
    expect(started(transport).beforeSend).toBe(scrub)
    expect(started(transport).beforeBreadcrumb).toBe(scrubBreadcrumb)
  })

  it('reports errors only, hears the window over the SDK’s scheme, and uploads no crash dump', () => {
    const { transport } = remembering()
    const options = started(transport)
    expect(options.tracesSampleRate).toBe(0)
    expect(options.sendClientReports).toBe(false)
    expect(options.ipcMode).toBe(2)
    expect(options.dataCollection.userInfo).toBe(false)
    expect(options.dataCollection.httpBodies).toEqual([])
    expect(
      options
        .integrations([
          { name: 'SentryMinidump' },
          { name: 'MainProcessSession' },
          { name: 'ChildProcess' },
          { name: 'Dedupe' },
        ])
        .map(({ name }) => name),
    ).toEqual(['Dedupe', 'ChildProcess'])
  })
})

describe('what was kept on disk while offline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is sent through the guard too, when the queue sends it later', async () => {
    const { seen, transport } = remembering()
    // An envelope already on disk, as a build from before the guard would have left it.
    const waiting = [envelope()]
    const store: OfflineStore = {
      push: (pushed) => Promise.resolve(void waiting.push(pushed)),
      unshift: (pushed) => Promise.resolve(void waiting.unshift(pushed)),
      shift: () => Promise.resolve(waiting.shift()),
    }
    // The SDK's own queue (`makeOfflineTransport`, which `makeElectronOfflineTransport` wraps),
    // over this store, sending what it finds at startup as the Electron one is set to.
    const options = settings({
      online: () => transport,
      queued: (base) => (handed) =>
        makeOfflineTransport(base)({ ...handed, createStore: () => store, flushAtStartup: true }),
      protocol: 2,
      sessions: () => [],
      ended: () => ({ name: 'ChildProcess' }),
    })
    options.transport(given)
    // The queue waits five seconds after startup before it sends what was kept (`START_DELAY`).
    await vi.advanceTimersByTimeAsync(5000)
    expect(seen).toHaveLength(1)
    expect(waiting).toEqual([])
    expect(JSON.stringify(seen)).not.toContain('PRIVATE')
    expect(JSON.stringify(seen)).not.toContain('screenshot.png')
  })
})
