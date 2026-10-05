import type { Envelope, Transport } from '@sentry/core'
import { describe, expect, it } from 'vitest'
import { reports, settings } from './options'
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

describe('whether reporting starts', () => {
  it('starts only in a release build on a phone', () => {
    expect(reports({ development: false, platform: 'ios' })).toBe(true)
    expect(reports({ development: false, platform: 'android' })).toBe(true)
    expect(reports({ development: true, platform: 'ios' })).toBe(false)
    expect(reports({ development: false, platform: 'web' })).toBe(false)
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

  it('leaves out the integrations that write into the native scope or trace', () => {
    const { transport } = remembering()
    const names = [
      'ExpoContext',
      'TurboModuleContext',
      'ExpoUpdatesListener',
      'TimeToDisplay',
      'Dedupe',
    ]
    expect(
      settings(() => transport)
        .integrations(names.map((name) => ({ name })))
        .map(({ name }) => name),
    ).toEqual(['Dedupe'])
  })

  it('keeps native crash reporting on and every other native collector off', () => {
    const { transport } = remembering()
    const started = settings(() => transport)
    expect(started.enableNativeCrashHandling).toBe(true)
    // Everything else the native SDKs would collect or send by themselves, each named: a switch
    // that is missing here is one a native crash report can carry again.
    expect({
      tracesSampleRate: started.tracesSampleRate,
      enableAutoPerformanceTracing: started.enableAutoPerformanceTracing,
      enableAppStartTracking: started.enableAppStartTracking,
      enableNativeFramesTracking: started.enableNativeFramesTracking,
      enableStallTracking: started.enableStallTracking,
      enableUserInteractionTracing: started.enableUserInteractionTracing,
      enableAutoSessionTracking: started.enableAutoSessionTracking,
      sendClientReports: started.sendClientReports,
      enableAppHangTracking: started.enableAppHangTracking,
      sendDefaultPii: started.sendDefaultPii,
      attachScreenshot: started.attachScreenshot,
      attachViewHierarchy: started.attachViewHierarchy,
      enableCaptureFailedRequests: started.enableCaptureFailedRequests,
      enableNetworkBreadcrumbs: started.enableNetworkBreadcrumbs,
      enableAutoBreadcrumbTracking: started.enableAutoBreadcrumbTracking,
      enableNetworkEventBreadcrumbs: started.enableNetworkEventBreadcrumbs,
      enableActivityLifecycleBreadcrumbs: started.enableActivityLifecycleBreadcrumbs,
      enableAppLifecycleBreadcrumbs: started.enableAppLifecycleBreadcrumbs,
      enableSystemEventBreadcrumbs: started.enableSystemEventBreadcrumbs,
      enableAppComponentBreadcrumbs: started.enableAppComponentBreadcrumbs,
    }).toEqual({
      tracesSampleRate: 0,
      enableAutoPerformanceTracing: false,
      enableAppStartTracking: false,
      enableNativeFramesTracking: false,
      enableStallTracking: false,
      enableUserInteractionTracing: false,
      enableAutoSessionTracking: false,
      sendClientReports: false,
      enableAppHangTracking: false,
      sendDefaultPii: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      enableCaptureFailedRequests: false,
      enableNetworkBreadcrumbs: false,
      enableAutoBreadcrumbTracking: false,
      enableNetworkEventBreadcrumbs: false,
      enableActivityLifecycleBreadcrumbs: false,
      enableAppLifecycleBreadcrumbs: false,
      enableSystemEventBreadcrumbs: false,
      enableAppComponentBreadcrumbs: false,
    })
  })
})
