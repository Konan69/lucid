import { Option, Schema } from 'effect'

/**
 * Egress: the Computer's browser sends its traffic out through the Person's own computer.
 *
 * A Person signs in to sites at home, and the Computer is a machine in a datacentre. A sign-in
 * made at home and then used from a datacentre address is what sites revoke (a GitHub session,
 * 13 October 2026). So each connection the Computer's browser opens becomes a numbered stream:
 * the Computer says where it wants to go, the desktop app on the Person's computer dials that
 * place itself, and bytes are carried both ways. The site sees the Person's own address.
 *
 * The frame protocol is Grok Bot's, byte for byte
 * (`grok-bot-0.39-reconstructed/frontend/src-main/main-app/ea2-window-lifecycle.ts`:
 * `decodeFrame`, `encodeData`, `encodeClose`): one kind byte, the stream number as an unsigned
 * 32-bit big-endian integer, then for an open the port as an unsigned 16-bit big-endian integer
 * followed by the host in UTF-8, and for data the payload. A close carries nothing more.
 */

/** One stream's number, chosen by the side that opens it (the Computer). Unsigned 32 bits. */
export const EgressStream = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 0xffff_ffff }),
).pipe(Schema.brand('EgressStream'))
export type EgressStream = typeof EgressStream.Type

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
 * - `Close`: this stream is over, from either side. An `Open` that is refused (the name does not
 *   resolve, or it leads into the Person's own network) is answered with a `Close` and nothing else.
 */
export const EgressFrame = Schema.TaggedUnion({
  Open: { stream: EgressStream, host: EgressHost, port: EgressPort },
  Data: { stream: EgressStream, payload: Schema.Uint8Array },
  Close: { stream: EgressStream },
})
export type EgressFrame = typeof EgressFrame.Type

/** The kind byte of each frame: the reference's own numbers. */
const KIND = { Open: 1, Data: 2, Close: 3 } as const

/** Kind byte and stream number: every frame begins with these five bytes. */
const HEAD = 5

const headed = (kind: number, stream: EgressStream, more: number) => {
  const bytes = new Uint8Array(HEAD + more)
  bytes[0] = kind
  new DataView(bytes.buffer).setUint32(1, stream)
  return bytes
}

/** One frame as the bytes of one message. */
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
    Close: ({ stream }) => headed(KIND.Close, stream, 0),
  })

const isHost = Schema.is(EgressHost)

/**
 * Reads one message as a frame, once, where it arrives. Nothing means the bytes are not a frame
 * of this protocol (too short, an unknown kind, a port of zero, a host that is not printable
 * ASCII), and they are dropped: the
 * reference ignores such a message and keeps the tunnel (`handleFrame`), so one bad message does
 * not end every stream. A data payload is a view of the message, not a copy.
 */
export const decodeEgressFrame = (bytes: Uint8Array): Option.Option<EgressFrame> => {
  if (bytes.length < HEAD) return Option.none()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const stream = EgressStream.make(view.getUint32(1))
  if (bytes[0] === KIND.Data)
    return Option.some(EgressFrame.cases.Data.make({ stream, payload: bytes.subarray(HEAD) }))
  if (bytes[0] === KIND.Close) return Option.some(EgressFrame.cases.Close.make({ stream }))
  if (bytes[0] !== KIND.Open || bytes.length < HEAD + 2) return Option.none()
  const port = view.getUint16(HEAD)
  if (port === 0) return Option.none()
  const host = String.fromCharCode(...bytes.subarray(HEAD + 2))
  if (!isHost(host)) return Option.none()
  return Option.some(EgressFrame.cases.Open.make({ stream, host, port }))
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
