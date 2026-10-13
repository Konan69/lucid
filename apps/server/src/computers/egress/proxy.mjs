// The Computer's side of egress: the proxy the Computer's browser is pointed at, and the place
// the tunnel to the Person's own computer attaches (`packages/contracts/src/egress.ts`).
//
// It runs on the Computer as plain Node with nothing installed, so it imports only Node and
// repeats the frame layout of the contract in place of importing it; `egress.test.ts` in the
// desktop app runs this file against the desktop's real exit client, which is what holds the two
// to one protocol.
//
// Grok Bot's machine has the same two listeners (`ea2-window-lifecycle.ts`, the port table:
// `egressTunnelWebSocket: 8790`, `egressConnectProxy: 8791`). Its machine-side program is not in
// any of the reconstructions, which hold the desktop app only, so this is written as the mirror
// image of that app's exit client (`EgressTunnelExitClient`): it opens the streams the client
// accepts, in the frames the client reads. One thing differs and is Vivid's: the tunnel reaches
// this machine over the server's SSH connection, which is a byte stream and not a WebSocket, so
// here each frame is preceded by its length (unsigned 32 bits, big-endian).
//
// The browser must never lose the internet because nobody is at home: while no tunnel is
// attached every connection is dialled from this machine directly, exactly as without egress.
//
// Usage: node proxy.mjs <tunnel port> <proxy port> [pid file]
// Both listeners are on loopback only. A port of 0 asks the system for a free one; the ports in
// use are printed as one JSON line once both listen, and a line follows each time a tunnel
// attaches or goes.
import * as NodeFS from 'node:fs'
import * as NodeHttp from 'node:http'
import * as NodeNet from 'node:net'
import * as NodeStream from 'node:stream'

const OPEN = 1
const DATA = 2
const CLOSE = 3
// The largest frame taken from the tunnel. The exit client sends what one socket read gave it,
// well under this; a longer one is not that client keeping its own rule.
const FRAME_LIMIT = 16 * 1024 * 1024
// How much one stream may hold that the browser has not read yet. The protocol has no way to
// tell the far end to slow one stream down, and pausing the tunnel would stop every other
// connection for the sake of one. So a connection the browser has stopped reading (a paused
// video, say) is closed once this much waits for it; the browser asks again when it wants more.
const BACKLOG_LIMIT = 32 * 1024 * 1024

const [tunnelPort, proxyPort, pidFile] = process.argv.slice(2)

/** The attached tunnel: its socket, the streams open over it, and the last stream number. */
let attached = null

const framed = (kind, stream, more) => {
  const bytes = Buffer.allocUnsafe(4 + 5 + more.length)
  bytes.writeUInt32BE(5 + more.length, 0)
  bytes[4] = kind
  bytes.writeUInt32BE(stream, 5)
  more.copy(bytes, 9)
  return bytes
}

const NOTHING = Buffer.alloc(0)

/**
 * One connection of the browser's as a stream over the tunnel. It is a Duplex so that Node's own
 * back-pressure does the work the exit client does by hand: a write is finished only when the
 * tunnel's socket has taken the bytes, so a browser that uploads faster than the tunnel drains
 * is paused by `pipe`, not buffered without limit.
 *
 * A close from either side ends the whole stream; the protocol has no half-close (the exit
 * client forgets a stream the moment it reads a close).
 */
const openStream = (tunnel, host, port) => {
  do tunnel.last = (tunnel.last + 1) >>> 0
  while (tunnel.streams.has(tunnel.last))
  const id = tunnel.last
  // Said once, by whichever comes first: the browser finishing, or the connection being dropped.
  const closed = () => {
    if (tunnel.streams.get(id) !== stream) return
    tunnel.streams.delete(id)
    if (!tunnel.socket.destroyed) tunnel.socket.write(framed(CLOSE, id, NOTHING))
  }
  const stream = new NodeStream.Duplex({
    read() {},
    write(chunk, _encoding, done) {
      if (tunnel.streams.get(id) !== stream || tunnel.socket.destroyed) return done()
      return tunnel.socket.write(framed(DATA, id, chunk), () => done())
    },
    final(done) {
      closed()
      this.push(null)
      done()
    },
    destroy(error, done) {
      closed()
      done(error)
    },
  })
  // Node's HTTP client calls these on whatever carries a request; a stream has no use for them.
  for (const name of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref'])
    stream[name] = () => stream
  tunnel.streams.set(id, stream)
  const target = Buffer.from(host, 'utf8')
  const open = Buffer.allocUnsafe(2 + target.length)
  open.writeUInt16BE(port, 0)
  target.copy(open, 2)
  tunnel.socket.write(framed(OPEN, id, open))
  return stream
}

/** What the exit client said about one stream. A stream it does not know is one already over. */
const received = (tunnel, frame) => {
  if (frame.length < 5) return
  const stream = tunnel.streams.get(frame.readUInt32BE(1))
  if (stream === undefined) return
  if (frame[0] === DATA) {
    stream.push(frame.subarray(5))
    if (stream.readableLength > BACKLOG_LIMIT) stream.destroy()
  }
  if (frame[0] === CLOSE) {
    // The far end is over (or the open was refused). What it already sent is still read to the
    // end by the browser; nothing more is sent to it.
    tunnel.streams.delete(frame.readUInt32BE(1))
    stream.push(null)
    stream.end()
  }
}

/** One line on standard output for each thing worth knowing about: the ports, and the tunnel. */
const say = (fact) => process.stdout.write(`${JSON.stringify(fact)}\n`)

const detach = (tunnel) => {
  if (attached === tunnel) {
    attached = null
    say({ attached: false })
  }
  tunnel.socket.destroy()
  for (const stream of tunnel.streams.values()) stream.destroy()
  tunnel.streams.clear()
}

/**
 * The tunnel's end on this machine. One at a time: a new attachment is the server joining a
 * desktop app again, so it replaces the one before, and the streams of the old one end.
 */
const tunnels = NodeNet.createServer((socket) => {
  if (attached !== null) detach(attached)
  const tunnel = { socket, streams: new Map(), last: 0 }
  attached = tunnel
  say({ attached: true })
  let held = NOTHING
  socket.on('data', (chunk) => {
    held = held.length === 0 ? chunk : Buffer.concat([held, chunk])
    while (held.length >= 4) {
      const size = held.readUInt32BE(0)
      if (size > FRAME_LIMIT) return detach(tunnel)
      if (held.length < 4 + size) return undefined
      received(tunnel, held.subarray(4, 4 + size))
      held = held.subarray(4 + size)
    }
    return undefined
  })
  socket.on('error', () => detach(tunnel))
  socket.on('close', () => detach(tunnel))
})

/** Where a connection goes: through the Person's computer when one is attached, else from here. */
const dial = (host, port) =>
  attached === null ? NodeNet.connect({ host, port }) : openStream(attached, host, port)

const join = (near, far) => {
  near.pipe(far)
  far.pipe(near)
  near.on('error', () => far.destroy())
  far.on('error', () => near.destroy())
  near.on('close', () => far.destroy())
  far.on('close', () => near.destroy())
}

const proxy = NodeHttp.createServer()

// HTTPS, and everything else the browser tunnels: `CONNECT host:port`.
proxy.on('connect', (request, client, head) => {
  const at = request.url.lastIndexOf(':')
  const host = request.url.slice(0, at).replace(/^\[|\]$/g, '')
  const port = Number(request.url.slice(at + 1))
  if (at < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
    client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }
  // The protocol has no word for "connected": an open is followed by data, and a refusal is a
  // close. So the browser is told the tunnel stands at once, and a target that is refused or
  // unreachable shows as that connection closing.
  const far = dial(host, port)
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  if (head.length > 0) far.write(head)
  join(client, far)
})

// Plain HTTP: the browser sends the whole address (`GET http://host/path`). One request is one
// connection outward, sent on in origin form.
proxy.on('request', (request, response) => {
  if (!URL.canParse(request.url) || new URL(request.url).protocol !== 'http:') {
    response.writeHead(400).end()
    return
  }
  const url = new URL(request.url)
  const headers = { ...request.headers }
  delete headers['proxy-connection']
  // An agent of its own, used once: its connection is whatever `dial` gives, and nothing is
  // kept for a later request (Node asks the agent, not the request's options, for the socket).
  const once = new NodeHttp.Agent({ keepAlive: false })
  once.createConnection = () =>
    dial(url.hostname.replace(/^\[|\]$/g, ''), url.port === '' ? 80 : Number(url.port))
  const outward = NodeHttp.request({
    method: request.method,
    path: `${url.pathname}${url.search}`,
    headers,
    agent: once,
  })
  outward.on('response', (answer) => {
    response.writeHead(answer.statusCode, answer.rawHeaders)
    answer.pipe(response)
  })
  outward.on('error', () => {
    if (response.headersSent) response.destroy()
    else response.writeHead(502).end()
  })
  response.on('close', () => outward.destroy())
  request.pipe(outward)
})
proxy.on('clientError', (_error, socket) => socket.destroy())

// Another copy already holds the ports: it is the one in use, and this one has nothing to do.
const taken = () => process.exit(75)
tunnels.on('error', taken)
proxy.on('error', taken)
tunnels.listen(Number(tunnelPort), '127.0.0.1', () => {
  proxy.listen(Number(proxyPort), '127.0.0.1', () => {
    if (pidFile !== undefined) NodeFS.writeFileSync(pidFile, `${process.pid}\n`)
    say({ tunnel: tunnels.address().port, proxy: proxy.address().port })
  })
})
