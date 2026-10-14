import { Result, Schema } from 'effect'

/**
 * Egress: the Computer's browser sends its traffic out through the Person's own computer.
 *
 * A Person signs in to sites at home, and the Computer is a machine in a datacentre. A sign-in
 * made at home and then used from a datacentre address is what sites revoke (a GitHub session,
 * 13 October 2026). So each connection the Computer's browser opens becomes a numbered stream:
 * the Computer says where it wants to go, the desktop app on the Person's computer dials that
 * place itself, and bytes are carried both ways. The site sees the Person's own address.
 *
 * The frame protocol is Grok Bot's
 * (`grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts`:
 * `decodeFrame`, `encodeData`, `encodeClose`): one kind byte, the stream number as an unsigned
 * 32-bit big-endian integer, then for an open the port as an unsigned 16-bit big-endian integer
 * followed by the host in UTF-8, and for data the payload. A close carries nothing more. Its
 * three kinds keep their numbers and their bytes. One kind is Vivid's: `End` (see `EgressFrame`).
 *
 * ## How much a hop may hold
 *
 * There are three hops: the proxy on the Computer, the server between, and the desktop app. The
 * reference has no bound on what waits toward a slow site, and the protocol has no way to tell
 * the far end to slow one stream down. This is the one rule every hop keeps, in both directions:
 *
 * 1. Where a hop reads a stream's bytes from a socket of that stream's own (the browser's on the
 *    Computer, the site's on the Person's computer), it stops reading that socket while the link
 *    ahead is full. Nothing is held and nothing is lost.
 * 2. Where a hop reads from the link and writes to the link (the server), it holds nothing for
 *    any one stream: it reads one link only as fast as the other takes what was read.
 * 3. Where a stream's bytes come off the link toward a socket of that stream's own, the hop
 *    cannot slow that one stream without stopping all of them. It holds what the socket has not
 *    taken, up to `EGRESS_STREAM_BUDGET` for one stream and `EGRESS_LINK_BUDGET` for all the
 *    streams of the link together. The stream whose bytes cross either bound is ended with a
 *    `Close`, and the others go on.
 *
 * So a hop's memory for a link is bounded, and a slow site or a browser that has stopped reading
 * costs that one connection, never the others. What it costs is real: an upload larger than the
 * budget, to a site that takes it more slowly than the Computer sends it, is cut. A window for
 * each stream would remove that; the reference has none, and none is added here.
 */

/** The most bytes one frame may be. A longer one is not this protocol, wherever it arrives. */
export const EGRESS_FRAME_LIMIT = 1 << 20

/** The most a hop holds for one stream that its socket has not taken (rule 3 above). */
export const EGRESS_STREAM_BUDGET = 32 * 1024 * 1024

/** The most a hop holds for all the streams of one link together (rule 3 above). */
export const EGRESS_LINK_BUDGET = 96 * 1024 * 1024

/** One stream's number, chosen by the side that opens it (the Computer). Unsigned 32 bits. */
export const EgressStream = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 0xffff_ffff }),
).pipe(Schema.brand('EgressStream'))
export type EgressStream = typeof EgressStream.Type

/** The longest a host may be: the longest a name can be. */
const HOST_LIMIT = 255

/**
 * Where a stream is opened to: a host name or an address literal, in printable ASCII. A browser
 * names a host that way on the wire (an international name travels as its `xn--` form), and one
 * byte is then one character, so no text codec stands between the bytes and the name.
 */
export const EgressHost = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,255}$/u))

/** A TCP port a stream may be opened to. */
export const EgressPort = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))

/**
 * What crosses the tunnel.
 *
 * - `Open`: the Computer asks for a connection to `host:port`. The host is a name or an address
 *   literal; it is resolved on the Person's computer, never on the Computer.
 * - `Data`: bytes of one stream, in either direction, in order.
 * - `End`: the sender has no more bytes for this stream, and still reads the other direction. A
 *   browser that has sent its whole request ends its side and waits for the answer; without this
 *   word the answer had nowhere to go. A stream is over when each side has sent one. It is
 *   Vivid's addition, with a kind number the reference does not use; the reference's client
 *   passes over a kind it does not know.
 * - `Close`: this stream is over in both directions, now, from either side: the connection was
 *   dropped or failed, or the stream went over its budget. An `Open` that is refused (the name
 *   does not resolve, or it leads into the Person's own network) is answered with a `Close` and
 *   nothing else. Bytes for a stream after its `Close` are for a stream nobody has, and are
 *   passed over.
 */
export const EgressFrame = Schema.TaggedUnion({
  Open: { stream: EgressStream, host: EgressHost, port: EgressPort },
  Data: { stream: EgressStream, payload: Schema.Uint8Array },
  End: { stream: EgressStream },
  Close: { stream: EgressStream },
})
export type EgressFrame = typeof EgressFrame.Type

/** The kind byte of each frame: the reference's own numbers, and four for `End`. */
const KIND = { Open: 1, Data: 2, Close: 3, End: 4 } as const

/** Kind byte and stream number: every frame begins with these five bytes. */
const HEAD = 5

/** The most payload one `Data` frame carries (`EGRESS_FRAME_LIMIT`). */
export const EGRESS_PAYLOAD_LIMIT = EGRESS_FRAME_LIMIT - HEAD

const headed = (kind: number, stream: EgressStream, more: number) => {
  const bytes = new Uint8Array(HEAD + more)
  bytes[0] = kind
  new DataView(bytes.buffer).setUint32(1, stream)
  return bytes
}

/**
 * One frame as the bytes of one message. A `Data` frame's payload is the caller's to keep within
 * `EGRESS_PAYLOAD_LIMIT` (`egressData` cuts a longer run of bytes into frames that are).
 */
export const encodeEgressFrame = (frame: EgressFrame): Uint8Array =>
  EgressFrame.match(frame, {
    Open: ({ stream, host, port }) => {
      const bytes = headed(KIND.Open, stream, 2 + host.length)
      new DataView(bytes.buffer).setUint16(HEAD, port)
      // `EgressHost` is ASCII, so a character's code is its byte.
      for (let at = 0; at < host.length; at += 1) bytes[HEAD + 2 + at] = host.charCodeAt(at)
      return bytes
    },
    Data: ({ stream, payload }) => {
      const bytes = headed(KIND.Data, stream, payload.length)
      bytes.set(payload, HEAD)
      return bytes
    },
    End: ({ stream }) => headed(KIND.End, stream, 0),
    Close: ({ stream }) => headed(KIND.Close, stream, 0),
  })

/**
 * Bytes of one stream as the messages that carry them, in order: one `Data` frame, or several
 * when there are more bytes than one frame may hold. A socket hands over what one read gave it,
 * which is far under the limit, but nothing promises that, and a frame over the limit ends the
 * link at whoever reads it.
 */
export const egressData = (stream: EgressStream, payload: Uint8Array): ReadonlyArray<Uint8Array> =>
  Array.from({ length: Math.ceil(payload.length / EGRESS_PAYLOAD_LIMIT) }, (_, part) =>
    encodeEgressFrame(
      EgressFrame.cases.Data.make({
        stream,
        payload: payload.subarray(part * EGRESS_PAYLOAD_LIMIT, (part + 1) * EGRESS_PAYLOAD_LIMIT),
      }),
    ),
  )

/**
 * Why bytes were not read as a frame. Each asks something different of whoever read them:
 *
 * - `Oversized`: longer than any frame. The sender is not keeping the protocol, and the link it
 *   came over is ended; nothing else is.
 * - `Short` and `Unknown`: too few bytes to say which stream, or a kind this side does not know.
 *   Passed over, and the link stays, as the reference does (`handleFrame`): one bad message does
 *   not end every stream, and a kind added later is not an attack.
 * - `Unopenable`: an open whose port or host is not one. The stream is known, so it is answered
 *   with a `Close`; passed over, the browser's connection would wait for ever.
 */
export const EgressRefusal = Schema.TaggedUnion({
  Oversized: { size: Schema.Int },
  Short: {},
  Unknown: { kind: Schema.Int },
  Unopenable: { stream: EgressStream },
})
export type EgressRefusal = typeof EgressRefusal.Type

const isHost = Schema.is(EgressHost)

/**
 * Reads one message as a frame, once, where it arrives, or says why it is not one
 * (`EgressRefusal`). Lengths are checked before anything is made from the bytes, so no message,
 * however long or however wrong, does more than be refused. A data payload is a view of the
 * message, not a copy.
 */
export const decodeEgressFrame = (bytes: Uint8Array): Result.Result<EgressFrame, EgressRefusal> => {
  if (bytes.length > EGRESS_FRAME_LIMIT)
    return Result.fail(EgressRefusal.cases.Oversized.make({ size: bytes.length }))
  if (bytes.length < HEAD) return Result.fail(EgressRefusal.cases.Short.make({}))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const stream = EgressStream.make(view.getUint32(1))
  const kind = view.getUint8(0)
  if (kind === KIND.Data)
    return Result.succeed(EgressFrame.cases.Data.make({ stream, payload: bytes.subarray(HEAD) }))
  if (kind === KIND.End) return Result.succeed(EgressFrame.cases.End.make({ stream }))
  if (kind === KIND.Close) return Result.succeed(EgressFrame.cases.Close.make({ stream }))
  if (kind !== KIND.Open) return Result.fail(EgressRefusal.cases.Unknown.make({ kind }))
  const unopenable = Result.fail(EgressRefusal.cases.Unopenable.make({ stream }))
  const named = bytes.subarray(HEAD + 2)
  if (bytes.length < HEAD + 2 || named.length > HOST_LIMIT) return unopenable
  const port = view.getUint16(HEAD)
  const host = String.fromCharCode(...named)
  if (port === 0 || !isHost(host)) return unopenable
  return Result.succeed(EgressFrame.cases.Open.make({ stream, host, port }))
}

/** Why egress is on and cannot work. */
export const EgressFailure = Schema.Literals([
  /** The Computer could not be reached, or would not start what carries the browser's traffic. */
  'Computer',
])
export type EgressFailure = typeof EgressFailure.Type

/**
 * What egress is doing for a Person right now. It is the server's reading of both ends and is
 * never stored: it is true only while the connections it describes are open.
 *
 * - `Off`: the Person has not turned it on. The Computer's browser goes out directly.
 * - `Waiting`: on, and not carrying anything yet: no desktop app of this Person's is connected,
 *   or the Computer is not running. The browser goes out directly meanwhile.
 * - `Routing`: a desktop app and the Computer are joined. `streams` is how many connections of
 *   the browser's were open through the Person's computer when this was read; a watcher is told
 *   when the case changes, not each time the count does.
 * - `Failed`: on, both ends are there, and they could not be joined.
 */
export const EgressStatus = Schema.TaggedUnion({
  Off: {},
  Waiting: {},
  Routing: { streams: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) },
  Failed: { reason: EgressFailure },
})
export type EgressStatus = typeof EgressStatus.Type

/** Where the desktop app opens the tunnel on its server: a WebSocket, as the app's own session. */
export const EGRESS_PATH = '/api/computer/egress'
