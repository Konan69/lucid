import * as NodeChildProcess from 'node:child_process'
import * as NodeCrypto from 'node:crypto'
import * as NodeHttp from 'node:http'
import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Option from 'effect/Option'

class DesktopProofFailed extends Schema.TaggedError<DesktopProofFailed>()(
  'DesktopProofFailed',
  {},
  { title: 'Desktop transport proof failed' },
) {}

const decodeSocketKey = Schema.decodeUnknownOption(Schema.String)

const Proof = Schema.Struct({
  success: Schema.Literal(true),
  data: Schema.Struct({
    result: Schema.Struct({
      origin: Schema.String,
      posted: Schema.String,
      cookie: Schema.String,
      redirect: Schema.String,
      streamed: Schema.String,
      socket: Schema.String,
      assetStatus: Schema.Number,
    }),
  }),
})
const decodeProof = Schema.decodeUnknownEffect(Schema.fromJsonString(Proof))

/** A disposable HTTP server proves the Electron forwarding adapter, with no app database involved. */
const fixture = Effect.acquireRelease(
  Effect.callback<NodeHttp.Server, DesktopProofFailed>((resume) => {
    const server = NodeHttp.createServer((request, response) => {
      if (request.url === '/health') {
        response.end('{"ok":true,"service":"vivid"}')
      } else if (request.url === '/api/proof/cookie') {
        response.setHeader('set-cookie', 'vivid-proof=present; Path=/; HttpOnly; SameSite=Lax')
        response.end('set')
      } else if (request.url === '/api/proof/session') {
        response.end(request.headers.cookie)
      } else if (request.url === '/api/proof/redirect') {
        response.writeHead(302, { location: '/api/proof/session' })
        response.end()
      } else if (request.url === '/api/proof/stream') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'x-content-type-options': 'nosniff',
        })
        response.write('first-frame')
        request.once('close', () => response.end())
      } else if (request.url === '/api/proof/post') {
        request.pipe(response)
      } else {
        response.writeHead(404)
        response.end()
      }
    })
    // The real Chromium upgrade bypasses the HTTP protocol handler, as it must in production.
    server.on('upgrade', (request, socket) => {
      const key = decodeSocketKey(request.headers['sec-websocket-key'])
      if (Option.isNone(key)) {
        socket.end()
        return
      }
      const accept = NodeCrypto.createHash('sha1')
        .update(`${key.value}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      socket.end(Buffer.concat([Buffer.from([0x81, 12]), Buffer.from('vivid-socket')]))
    })
    server.once('error', () => resume(Effect.fail(new DesktopProofFailed({}))))
    server.listen(8797, '127.0.0.1', () => resume(Effect.succeed(server)))
    return Effect.sync(() => server.close())
  }),
  (server) =>
    Effect.sync(() => {
      server.closeAllConnections()
      server.close()
    }),
)

/** Run the installed browser CLI against the isolated, already-running packaged Electron client. */
const evaluate = Effect.fn('DesktopProof.evaluate')(function* (expression: string) {
  const output = yield* Effect.callback<string, DesktopProofFailed>((resume) => {
    const child = NodeChildProcess.execFile(
      'agent-browser',
      ['--session', 'vivid-desktop-lane', '--json', 'eval', expression],
      (error, stdout) => {
        if (error !== null) return resume(Effect.fail(new DesktopProofFailed({})))
        resume(Effect.succeed(stdout))
      },
    )
    return Effect.sync(() => child.kill())
  })
  return yield* decodeProof(output)
})

/**
 * Opt in only with an isolated packaged client attached as vivid-desktop-lane, selected origin
 * http://127.0.0.1:8797. The first stream frame and socket message are awaited receipts, never sleeps.
 */
it.live.runIf(process.env.VIVID_DESKTOP_LIVE_TEST === '1')(
  'forwards HTTP, cookies, redirects, streaming, and WebSockets',
  () =>
    Effect.gen(function* () {
      yield* fixture
      const proof = yield* evaluate(`(async () => {
      const posted = await (await fetch('/api/proof/post', {method: 'POST', body: 'vivid-body'})).text();
      await fetch('/api/proof/cookie');
      const cookie = await (await fetch('/api/proof/session')).text();
      const redirect = await (await fetch('/api/proof/redirect')).text();
      const stream = await fetch('/api/proof/stream');
      const reader = stream.body.getReader();
      const frame = await reader.read();
      await reader.cancel();
      const socket = await new Promise((resolve, reject) => {
        const connection = new WebSocket('ws://127.0.0.1:8797/api/proof/socket');
        connection.onmessage = (event) => { resolve(event.data); connection.close(); };
        connection.onerror = reject;
      });
      const assetStatus = (await fetch('/')).status;
      return {origin: location.origin, posted, cookie, redirect,
        streamed: new TextDecoder().decode(frame.value), socket, assetStatus};
    })()`)
      expect(proof.data.result).toEqual({
        origin: 'http://127.0.0.1:8797',
        posted: 'vivid-body',
        cookie: 'vivid-proof=present',
        redirect: 'vivid-proof=present',
        streamed: 'first-frame',
        socket: 'vivid-socket',
        assetStatus: 200,
      })
    }),
)
