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
// accepts, in the frames the client reads. Two things differ and are Vivid's: the tunnel reaches
// this machine over the server's SSH connection, which is a byte stream and not a WebSocket, so
// here each frame is preceded by its length (unsigned 32 bits, big-endian); and a stream's two
// directions end apart (`END`), so a browser that has sent its whole request still gets its
// answer.
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
const END = 4
// The contract's own numbers (`EGRESS_FRAME_LIMIT`, `EGRESS_STREAM_BUDGET`, `EGRESS_LINK_BUDGET`),
// and its rule for how much a hop may hold ("How much a hop may hold"): `proxy.test.ts` sends
// this program the contract's numbers and fails when these are not the same.
const FRAME_LIMIT = 1 << 20
const PAYLOAD_LIMIT = FRAME_LIMIT - 5
const STREAM_BUDGET = 32 * 1024 * 1024
const LINK_BUDGET = 96 * 1024 * 1024

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
 * One connection of the browser's as a stream over the tunnel.
 *
 * Toward the far end it is the contract's first rule: a write is finished only when the tunnel's
 * socket has taken the bytes, so a browser that uploads faster than the tunnel drains is paused
 * by `pipe`, not buffered. From the far end it is the third: what the browser has not read waits
 * in this Duplex, up to the budgets (`received`).
 *
 * The two directions end apart. The browser finishing its request is an `End`: the stream stays
 * open the other way, for the answer. The stream is over when both sides have ended, or at once
 * when either says `Close` (the connection was dropped, or went over its budget). `over` is that
 * fact: after it nothing more is said about the stream, and what arrives for it is passed over.
 * The entry stays in the table until the Duplex is destroyed, so a stream that is over but
 * still holds bytes the browser has not read is still counted and still ended with the tunnel.
 */
const openStream = (tunnel, host, port) => {
  do tunnel.last = (tunnel.last + 1) >>> 0
  while (tunnel.streams.has(tunnel.last))
  const id = tunnel.last
  const entry = { sentEnd: false, heardEnd: false, over: false, duplex: null }
  const say = (kind, more, done = () => undefined) => {
    if (tunnel.socket.destroyed) return done()
    return tunnel.socket.write(framed(kind, id, more), done)
  }
  entry.duplex = new NodeStream.Duplex({
    read() {},
    write(chunk, _encoding, done) {
      if (entry.over) return done()
      // One socket read is far under a frame; nothing promises that, so more is cut into frames.
      for (let at = 0; at + PAYLOAD_LIMIT < chunk.length; at += PAYLOAD_LIMIT)
        say(DATA, chunk.subarray(at, at + PAYLOAD_LIMIT))
      const rest = chunk.length % PAYLOAD_LIMIT || Math.min(chunk.length, PAYLOAD_LIMIT)
      return say(DATA, chunk.subarray(chunk.length - rest), () => done())
    },
    // The browser has no more to send. The answer may still be on its way.
    final(done) {
      if (!entry.over) {
        say(END, NOTHING)
        entry.sentEnd = true
        entry.over = entry.heardEnd
      }
      done()
    },
    // Dropped, by the browser or by this program: the far end is told, unless it already knows.
    destroy(error, done) {
      if (!entry.over) say(CLOSE, NOTHING)
      entry.over = true
      if (tunnel.streams.get(id) === entry) tunnel.streams.delete(id)
      done(error)
    },
  })
  // Node's HTTP client calls these on whatever carries a request; a stream has no use for them.
  for (const name of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref'])
    entry.duplex[name] = () => entry.duplex
  tunnel.streams.set(id, entry)
  const target = Buffer.from(host, 'utf8')
  const open = Buffer.allocUnsafe(2 + target.length)
  open.writeUInt16BE(port, 0)
  target.copy(open, 2)
  say(OPEN, open)
  return entry.duplex
}

/** What every stream of a tunnel holds that its browser connection has not read yet. */
const held = (tunnel) => {
  let bytes = 0
  for (const { duplex } of tunnel.streams.values()) bytes += duplex.readableLength
  return bytes
}

/** Bytes of a stream from the far end: held for the browser, up to the budgets. */
const heardData = (tunnel, entry, payload) => {
  if (entry.heardEnd) return
  entry.duplex.push(payload)
  // The browser is not reading this connection (a paused video, say), or not reading enough of
  // them. This one is closed; the browser asks again when it wants more.
  if (entry.duplex.readableLength > STREAM_BUDGET || held(tunnel) > LINK_BUDGET)
    entry.duplex.destroy()
}

/** The far end has no more to send. The browser may still be sending. */
const heardEnd = (entry) => {
  if (entry.heardEnd) return
  entry.heardEnd = true
  entry.over = entry.sentEnd
  entry.duplex.push(null)
}

/**
 * The far end says the stream is over, both ways (or the open was refused). What it had already
 * sent is still read to its end by the browser, and then the connection is dropped, not left
 * half open.
 */
const heardClose = (entry) => {
  entry.over = true
  entry.duplex.once('end', () => entry.duplex.destroy())
  if (!entry.heardEnd) entry.duplex.push(null)
  if (entry.duplex.readableEnded) entry.duplex.destroy()
}

/**
 * What the far end said about one stream. A stream it does not know, or one that is over, is
 * passed over, and so is anything that is not `Data`, `End` or `Close`: the far end never opens.
 */
const received = (tunnel, frame) => {
  if (frame.length < 5) return
  const entry = tunnel.streams.get(frame.readUInt32BE(1))
  if (entry === undefined || entry.over) return
  if (frame[0] === DATA) heardData(tunnel, entry, frame.subarray(5))
  if (frame[0] === END) heardEnd(entry)
  if (frame[0] === CLOSE) heardClose(entry)
}

/** One line on standard output for each thing worth knowing about: the ports, and the tunnel. */
const say = (fact) => process.stdout.write(`${JSON.stringify(fact)}\n`)

const detach = (tunnel) => {
  if (attached === tunnel) {
    attached = null
    say({ attached: false })
  }
  tunnel.socket.destroy()
  // Each one takes itself out of the table as it goes, which a Map allows while it is walked.
  for (const { duplex } of tunnel.streams.values()) duplex.destroy()
}

/**
 * The tunnel's end on this machine. One at a time: a new attachment is the server joining a
 * desktop app again, so it replaces the one before, and the streams of the old one end. A
 * length no frame can have is not this protocol: that tunnel is let go, and nothing else is.
 */
const tunnels = NodeNet.createServer((socket) => {
  if (attached !== null) detach(attached)
  const tunnel = { socket, streams: new Map(), last: 0 }
  attached = tunnel
  say({ attached: true })
  let waiting = NOTHING
  socket.on('data', (chunk) => {
    waiting = waiting.length === 0 ? chunk : Buffer.concat([waiting, chunk])
    while (waiting.length >= 4) {
      const size = waiting.readUInt32BE(0)
      if (size > FRAME_LIMIT) return detach(tunnel)
      if (waiting.length < 4 + size) return undefined
      received(tunnel, waiting.subarray(4, 4 + size))
      waiting = waiting.subarray(4 + size)
    }
    return undefined
  })
  socket.on('error', () => detach(tunnel))
  socket.on('close', () => detach(tunnel))
})

/**
 * Where a connection goes: through the Person's computer when one is attached, else from here.
 * Either way the two directions end apart: a far end that has finished sending does not end
 * what the browser is still sending.
 */
const dial = (host, port) =>
  attached === null
    ? NodeNet.connect({ host, port, allowHalfOpen: true })
    : openStream(attached, host, port)

/**
 * Joins a browser's connection to its way out. An end on one side is passed to the other and
 * the join goes on (`pipe`); a failure or a drop on either side drops both. When the way out is
 * gone the browser's connection is closed once what was already written to it has left.
 */
const join = (near, far) => {
  near.pipe(far)
  far.pipe(near)
  near.on('error', () => far.destroy())
  far.on('error', () => near.destroy())
  near.on('close', () => far.destroy())
  far.on('close', () => near.destroySoon())
}

/** A host and a port as a browser writes them (`host:port`, an IPv6 host in brackets). */
const hostAndPort = (text) => {
  const at = text.lastIndexOf(':')
  const port = Number(text.slice(at + 1))
  if (at < 1 || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: text.slice(0, at).replace(/^\[|\]$/g, ''), port }
}

/** Where a plain HTTP request goes: its whole address, as a browser sends it to a proxy. */
const plainTarget = (address) => {
  if (!URL.canParse(address)) return null
  const url = new URL(address)
  if (url.protocol !== 'http:') return null
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port === '' ? 80 : Number(url.port),
    path: `${url.pathname}${url.search}`,
  }
}

const REFUSED = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'

const proxy = NodeHttp.createServer()

// HTTPS, and everything else the browser tunnels: `CONNECT host:port`.
proxy.on('connect', (request, client, head) => {
  const target = hostAndPort(request.url)
  if (target === null) {
    client.end(REFUSED)
    return
  }
  // The protocol has no word for "connected": an open is followed by data, and a refusal is a
  // close. So the browser is told the tunnel stands at once, and a target that is refused or
  // unreachable shows as that connection closing.
  const far = dial(target.host, target.port)
  client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  if (head.length > 0) far.write(head)
  join(client, far)
})

// A plain HTTP request that asks to change protocol (`ws://`): the request is sent on in origin
// form with its headers as they came, and from there the two ends are joined byte for byte, so
// the answer, whatever it is, and everything after it are the site's own.
proxy.on('upgrade', (request, client, head) => {
  const target = plainTarget(request.url)
  if (target === null) {
    client.end(REFUSED)
    return
  }
  const lines = [`${request.method} ${target.path} HTTP/${request.httpVersion}`]
  for (let at = 0; at < request.rawHeaders.length; at += 2)
    if (request.rawHeaders[at].toLowerCase() !== 'proxy-connection')
      lines.push(`${request.rawHeaders[at]}: ${request.rawHeaders[at + 1]}`)
  const far = dial(target.host, target.port)
  far.write(`${lines.join('\r\n')}\r\n\r\n`)
  if (head.length > 0) far.write(head)
  join(client, far)
})

// Plain HTTP: the browser sends the whole address (`GET http://host/path`). One request is one
// connection outward, sent on in origin form.
proxy.on('request', (request, response) => {
  const target = plainTarget(request.url)
  if (target === null) {
    response.writeHead(400, { connection: 'close' }).end()
    return
  }
  const headers = { ...request.headers }
  delete headers['proxy-connection']
  // An agent of its own, used once: its connection is whatever `dial` gives, and nothing is
  // kept for a later request (Node asks the agent, not the request's options, for the socket).
  const once = new NodeHttp.Agent({ keepAlive: false })
  once.createConnection = () => dial(target.host, target.port)
  const outward = NodeHttp.request({
    method: request.method,
    path: target.path,
    headers,
    agent: once,
  })
  outward.on('response', (answer) => {
    response.writeHead(answer.statusCode, answer.rawHeaders)
    answer.pipe(response)
  })
  outward.on('error', () => {
    if (response.headersSent) response.destroy()
    else response.writeHead(502, { connection: 'close' }).end()
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
