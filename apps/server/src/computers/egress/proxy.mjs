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
// here each frame is preceded by its length (unsigned 32 bits, big-endian); a stream's two
// directions end apart (`END`), so a browser that has sent its whole request still gets its
// answer; and each direction of a stream has a window (`GRANT`), so a slow site or a browser
// that is not reading slows that one connection and costs nothing else.
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
const GRANT = 5
// The contract's own numbers (`EGRESS_FRAME_LIMIT`, `EGRESS_WINDOW`, `EGRESS_GRANT`,
// `EGRESS_STREAM_BUDGET`, `EGRESS_LINK_BUDGET`), and its rule for how much a hop may hold ("How
// much a hop may hold"): `proxy.test.ts` sends this program the contract's numbers and fails
// when these are not the same.
const FRAME_LIMIT = 1 << 20
const PAYLOAD_LIMIT = FRAME_LIMIT - 5
const WINDOW = 2 * 1024 * 1024
const GRANT_AT = WINDOW / 2
const STREAM_BUDGET = 32 * 1024 * 1024
const LINK_BUDGET = 96 * 1024 * 1024

const [tunnelPort, proxyPort, pidFile, readyDescriptor] = process.argv.slice(2)

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
 * Each direction has a window (the contract's "How much a hop may hold"). Toward the far end
 * this program is the sender: a write of the browser's is finished only when the far end has
 * room for all of it and the tunnel's socket has taken it, so a browser that uploads faster
 * than the site takes it is paused by `pipe`, and nothing but the one write in hand waits here
 * (`pour`). From the far end it is the receiver: what arrives waits in `queue` until the
 * browser's side asks for it, and the far end is granted more only for what was asked for
 * (`feed`), so the queue never holds more than the window.
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
  const entry = {
    sentEnd: false,
    heardEnd: false,
    over: false,
    duplex: null,
    // How many more of the browser's bytes the far end will take: a whole window at the open.
    credit: WINDOW,
    // The browser's write in hand, when the far end has no room for all of it yet.
    waiting: null,
    // What the far end sent that the browser's side has not asked for yet, and its size.
    queue: [],
    queued: 0,
    // The browser's side asked for more than the queue had: the next bytes go straight to it.
    wanted: false,
    // Bytes the browser's side took that the far end has not been granted yet.
    taken: 0,
    // Nothing more will be queued: the browser's side is told once the queue is empty.
    last: false,
    pour: () => undefined,
    feed: () => undefined,
  }
  const say = (kind, more, done = () => undefined) => {
    if (tunnel.socket.destroyed) return done()
    return tunnel.socket.write(framed(kind, id, more), done)
  }
  // Sends the write in hand as far as the far end's window allows; a grant calls it again. A
  // write for a stream that is over is taken and dropped, so the browser's side is never left
  // waiting on a far end that will not answer.
  entry.pour = () => {
    const held = entry.waiting
    if (held === null) return
    if (entry.over) {
      entry.waiting = null
      held.done()
      return
    }
    while (entry.credit > 0) {
      const part = held.chunk.subarray(0, Math.min(entry.credit, PAYLOAD_LIMIT))
      held.chunk = held.chunk.subarray(part.length)
      entry.credit -= part.length
      if (held.chunk.length > 0) say(DATA, part)
      else {
        entry.waiting = null
        say(DATA, part, () => held.done())
        return
      }
    }
  }
  // Hands the browser's side what it asked for, and grants the far end that much more once it
  // comes to half a window. Bytes nobody asked for stay in the queue and are not granted.
  entry.feed = () => {
    while (entry.wanted && entry.queue.length > 0) {
      const chunk = entry.queue.shift()
      entry.queued -= chunk.length
      entry.taken += chunk.length
      entry.wanted = entry.duplex.push(chunk)
    }
    if (entry.taken >= GRANT_AT && !entry.heardEnd && !entry.over) {
      const more = Buffer.allocUnsafe(4)
      more.writeUInt32BE(entry.taken, 0)
      entry.taken = 0
      say(GRANT, more)
    }
    if (entry.last && entry.queue.length === 0) {
      entry.last = false
      entry.duplex.push(null)
    }
  }
  entry.duplex = new NodeStream.Duplex({
    read() {
      entry.wanted = true
      entry.feed()
    },
    write(chunk, _encoding, done) {
      if (chunk.length === 0) return done()
      entry.waiting = { chunk, done }
      return entry.pour()
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
      entry.queue.length = 0
      entry.queued = 0
      entry.pour()
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

/** What one stream holds that its browser connection has not read yet. */
const holding = (entry) => entry.queued + entry.duplex.readableLength

/** What every stream of a tunnel holds that its browser connection has not read yet. */
const held = (tunnel) => {
  let bytes = 0
  for (const entry of tunnel.streams.values()) bytes += holding(entry)
  return bytes
}

/**
 * Bytes of a stream from the far end. A far end that keeps its window never has more than the
 * window waiting here; one that does not is held to the budgets, and its stream is closed.
 */
const heardData = (tunnel, entry, payload) => {
  if (entry.heardEnd) return
  entry.queue.push(payload)
  entry.queued += payload.length
  entry.feed()
  if (holding(entry) > STREAM_BUDGET || held(tunnel) > LINK_BUDGET) entry.duplex.destroy()
}

/** The far end has no more to send. The browser may still be sending. */
const heardEnd = (entry) => {
  if (entry.heardEnd) return
  entry.heardEnd = true
  entry.over = entry.sentEnd
  entry.last = true
  entry.feed()
}

/**
 * The far end has room for more of what the browser sends. A grant is for bytes that were sent,
 * so credit never comes to more than the window: one that would is for bytes that never were
 * (said twice, or made up), and it ends its stream as any other break of the window does. It
 * was once added as it came, and one grant of four gigabytes let a browser upload without any
 * window.
 */
const heardGrant = (entry, frame) => {
  if (frame.length < 9) return
  const more = frame.readUInt32BE(5)
  if (entry.credit + more > WINDOW) {
    entry.duplex.destroy()
    return
  }
  entry.credit += more
  entry.pour()
}

/**
 * The far end says the stream is over, both ways (or the open was refused). What it had already
 * sent is still read to its end by the browser, and then the connection is dropped, not left
 * half open.
 */
const heardClose = (entry) => {
  entry.over = true
  entry.pour()
  entry.duplex.once('end', () => entry.duplex.destroy())
  if (!entry.heardEnd) {
    entry.last = true
    entry.feed()
  }
  if (entry.duplex.readableEnded) entry.duplex.destroy()
}

/**
 * What the far end said about one stream. A stream it does not know, or one that is over, is
 * passed over, and so is anything that is not `Data`, `End`, `Grant` or `Close`: the far end
 * never opens.
 */
const received = (tunnel, frame) => {
  if (frame.length < 5) return
  const entry = tunnel.streams.get(frame.readUInt32BE(1))
  if (entry === undefined || entry.over) return
  if (frame[0] === DATA) heardData(tunnel, entry, frame.subarray(5))
  if (frame[0] === END) heardEnd(entry)
  if (frame[0] === GRANT) heardGrant(entry, frame)
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
    // A site that goes before its answer is whole (it promised a length and hung up, or the
    // far end closed the stream) ends `answer` without finishing it, and `pipe` then leaves
    // the browser's response open for ever. The browser's connection is dropped instead: a
    // connection that closes short of the promised length is how it learns the answer is not
    // whole. The failure is the same fact, said first.
    answer.on('error', () => undefined)
    answer.on('close', () => {
      if (!answer.complete) response.destroy()
    })
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
    const bound = { tunnel: tunnels.address().port, proxy: proxy.address().port }
    // An inherited descriptor is owned by the launcher until both listeners have answered.
    // Closing it also makes an early child exit an EOF receipt for the launcher.
    if (readyDescriptor !== undefined) {
      NodeFS.writeSync(Number(readyDescriptor), `${JSON.stringify(bound)}\n`)
      NodeFS.closeSync(Number(readyDescriptor))
    }
    say(bound)
  })
})
