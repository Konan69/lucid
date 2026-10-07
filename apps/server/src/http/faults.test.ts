import * as NodeConsole from 'node:console'
import * as NodeStream from 'node:stream'
import { expect, layer } from '@effect/vitest'
import { NodeHttpServer } from '@effect/platform-node'
import { cutFault } from '@vivid/contracts'
import { Console, Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import { faultRoutes, REPORTS_PER_WINDOW, WINDOW_MILLIS } from './faults.ts'

/** How the default logger begins an entry: `[12:00:00.000] ERROR (#12)`. */
const ENTRY_HEAD = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] [A-Z]+ \(#\d+\)/

/**
 * The server's real output path, with the bytes kept instead of going to the terminal.
 *
 * `main.ts` installs no logger, so Effect's default one is in use: it calls `console.log` on the
 * `Console` service with the entry's head, its message and its annotations as separate arguments
 * (rc.116 `internal/effect.ts` `defaultLogger`), and Node's console formats them. So the seam is
 * the `Console` service, and what stands behind it here is a real Node `Console` over a stream
 * that keeps what is written. No formatter of this test's own is involved.
 */
const output = () => {
  const written: Array<string> = []
  const sink = new NodeStream.Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk))
      done()
    },
  })
  return {
    console: new NodeConsole.Console({ stdout: sink, stderr: sink }),
    /** Every physical line written so far. */
    lines: () => written.join('').split('\n').slice(0, -1),
  }
}

/** A client's report reaches the log with the error and where it happened; anything else does not. */
layer(NodeHttpServer.layerTest)((it) => {
  it.effect('logs a reported fault and refuses a body that is not one', () => {
    const stdout = output()
    /** The physical lines of each `Client fault` entry: its head, its annotation, its closing brace. */
    const entries = () => {
      const lines = stdout.lines()
      return lines.flatMap((line, at) =>
        ENTRY_HEAD.test(line) && line.includes('Client fault') ? [lines.slice(at, at + 3)] : [],
      )
    }
    return Effect.gen(function* () {
      yield* Layer.build(HttpRouter.serve(faultRoutes, { disableLogger: true }))
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
      expect(entries()).toHaveLength(1)
      // The message is the fixed one; the report rides beside it as one annotation, so the export
      // can count the fault without sending what the client said (`observability/export.ts`). The
      // entry is three physical lines, and the report is the quoted string on the second.
      const [first = []] = entries()
      expect(first[0]).toMatch(/: Client fault \{$/)
      expect(first[1]).toMatch(/^ {2}report: '\{"surface":"mobile"/)
      expect(first[1]).toContain('Skia is not linked')
      expect(first[1]).toContain('at Composer')
      expect(first[1]).toContain('ios 0.1.0 embedded')
      expect(first[2]).toBe('}')

      // The text is the sender's. A line break in it starts no line of output, and what follows
      // the break, written to look like an entry's head, is the head of no line.
      const forged = { ...fault, message: 'oops\n[12:00:00.000] ERROR (#1): forged' }
      expect((yield* send(JSON.stringify(forged))).status).toBe(204)
      expect(entries()).toHaveLength(2)
      const lines = stdout.lines()
      const carrying = lines.filter((line) => line.includes('forged'))
      expect(carrying).toHaveLength(1)
      expect(carrying.every((line) => line.startsWith("  report: '"))).toBe(true)
      expect(
        lines.filter((line) => line.startsWith('oops') || line.startsWith('[12:00:00.000]')),
      ).toEqual([])
      expect(lines.filter((line) => ENTRY_HEAD.test(line) && line.includes('forged'))).toEqual([])

      // Not a report, and a report longer than a client is allowed to send.
      expect((yield* send(JSON.stringify({ surface: 'toaster', message: 'x' }))).status).toBe(400)
      expect((yield* send(JSON.stringify({ ...fault, message: 'x'.repeat(2001) }))).status).toBe(
        400,
      )
      expect((yield* send(JSON.stringify({ ...fault, stack: 'x'.repeat(13_000) }))).status).toBe(
        400,
      )
      expect(entries()).toHaveLength(2)

      // A refused body still counts against the minute; past the budget nothing more is logged,
      // and the next minute starts again.
      for (let sent = 5; sent < REPORTS_PER_WINDOW; sent += 1)
        expect((yield* send(JSON.stringify(fault))).status).toBe(204)
      expect((yield* send(JSON.stringify(fault))).status).toBe(429)
      expect(entries()).toHaveLength(2 + REPORTS_PER_WINDOW - 5)
      yield* TestClock.adjust(WINDOW_MILLIS)
      expect((yield* send(JSON.stringify(fault))).status).toBe(204)
    }).pipe(Effect.provideService(Console.Console, stdout.console))
  })
})
