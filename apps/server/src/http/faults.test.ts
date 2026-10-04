import { expect, it } from '@effect/vitest'
import { NodeHttpServer } from '@effect/platform-node'
import { cutFault } from '@vivid/contracts'
import { Effect, Layer, Logger } from 'effect'
import { TestClock } from 'effect/testing'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import { faultRoutes, REPORTS_PER_WINDOW, WINDOW_MILLIS } from './faults.ts'

/** A client's report reaches the log with the error and where it happened; anything else does not. */
it.effect('logs a reported fault and refuses a body that is not one', () =>
  Effect.gen(function* () {
    const logged: Array<string> = []
    // The router logs too; only the reports are of interest here.
    const capture = Logger.make((entry) => {
      const line = Logger.formatSimple.log(entry)
      if (line.includes('Client fault')) logged.push(line)
    })
    yield* Layer.build(
      HttpRouter.serve(faultRoutes, { disableLogger: true }).pipe(
        Layer.provide(Logger.layer([capture])),
      ),
    )
    const client = yield* HttpClient.HttpClient
    /** The body as a client writes it: JSON text. */
    const send = (json: string) =>
      client.execute(
        HttpClientRequest.post('/api/faults').pipe(
          HttpClientRequest.bodyText(json, 'application/json'),
        ),
      )

    const thrown = new Error('Skia is not linked')
    const fault = cutFault({
      surface: 'mobile',
      thrown,
      components: '\n    at Composer\n    at Chat',
      build: 'ios 0.1.0 embedded',
    })
    expect((yield* send(JSON.stringify(fault))).status).toBe(204)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('Skia is not linked')
    expect(logged[0]).toContain('at Composer')
    expect(logged[0]).toContain('ios 0.1.0 embedded')

    // The text is the sender's: a line break in it must not start a log line of its own.
    const forged = { ...fault, message: 'oops\n[12:00:00.000] ERROR (#1): forged' }
    expect((yield* send(JSON.stringify(forged))).status).toBe(204)
    expect(logged).toHaveLength(2)
    expect(logged.join('\n').split('\n')).toHaveLength(2)

    // Not a report, and a report longer than a client is allowed to send.
    expect((yield* send(JSON.stringify({ surface: 'toaster', message: 'x' }))).status).toBe(400)
    expect((yield* send(JSON.stringify({ ...fault, message: 'x'.repeat(2001) }))).status).toBe(400)
    expect((yield* send(JSON.stringify({ ...fault, stack: 'x'.repeat(13_000) }))).status).toBe(400)
    expect(logged).toHaveLength(2)

    // A refused body still counts against the minute; past the budget nothing more is logged,
    // and the next minute starts again.
    for (let sent = 5; sent < REPORTS_PER_WINDOW; sent += 1)
      expect((yield* send(JSON.stringify(fault))).status).toBe(204)
    expect((yield* send(JSON.stringify(fault))).status).toBe(429)
    expect(logged).toHaveLength(2 + REPORTS_PER_WINDOW - 5)
    yield* TestClock.adjust(WINDOW_MILLIS)
    expect((yield* send(JSON.stringify(fault))).status).toBe(204)
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
)
