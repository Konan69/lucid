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
 * three kinds keep their numbers and their bytes. Two kinds are Vivid's: `End` and `Grant` (see
 * `EgressFrame`).
 *
 * ## How much a hop may hold
 *
 * There are three hops: the proxy on the Computer, the server between, and the desktop app. The
 * reference has no bound on what waits toward a slow site and no way to slow one stream down, so
 * a slow destination either filled memory or cost the connection. A Person's home connection is
 * slower than a datacentre's, so an ordinary upload is exactly that case. Each direction of each
 * stream therefore has a window, as a stream of yamux has
 * (`github.com/hashicorp/yamux` v0.1.2, `const.go` `initialStreamWindow`, and `stream.go`
 * `sendWindowUpdate`; the mechanism is yamux's, the size is not: `EGRESS_WINDOW`), and this is
 * the one rule, the same in both directions:
 *
 * 1. Whoever sends a stream's bytes (the proxy for what the browser sends, the desktop app for
 *    what the site sends) may have at most `EGRESS_WINDOW` bytes of that stream sent and not yet
 *    granted. It starts with the whole window at the `Open`, before the name is resolved. With
 *    none left it stops reading that stream's own socket, and reads it again when a `Grant`
 *    comes. The other streams go on.
 * 2. Whoever receives them writes them to the stream's own socket, and grants back only what
 *    that socket has taken, once that is `EGRESS_GRANT` bytes or more (half the window, yamux's
 *    own threshold, so a grant is not sent for every packet). So what a receiver holds for one
 *    stream is never more than the window. A stream whose name is still being resolved has
 *    taken nothing, so it is granted nothing: it holds the first window and no more.
 * 3. The server between holds nothing for any one stream and does not read the frames: a
 *    `Grant` passes through it like any other. It reads one link only as fast as the other
 *    takes what was read, which is the link's own pace and no stream's.
 *
 * A sender holds the receiver to the same arithmetic. A `Grant` is for bytes that were sent, so
 * what a sender may still send never comes to more than the window. A grant that would take it
 * past the window is for bytes that never were, and the sender ends that stream with a `Close`
 * and nothing else. A grant for a stream nobody has is passed over, like any frame for one.
 *
 * `EGRESS_STREAM_BUDGET` and `EGRESS_LINK_BUDGET` are what a receiver does when the far end does
 * not keep rule 1: a stream holding more than the first, or a link holding more than the second
 * in all, is ended with a `Close`. A far end that keeps the rule never reaches the first, and
 * reaches the second only with more connections stuck at once than a browser's pages make
 * (`EGRESS_LINK_BUDGET`).
 */

/** The most bytes one frame may be. A longer one is not this protocol, wherever it arrives. */
export const EGRESS_FRAME_LIMIT = 1 << 20

/**
 * How many bytes of one stream, in one direction, may be sent and not yet granted: two
 * mebibytes.
 *
 * It began as yamux's initial stream window, 256 KiB, and that number set the speed of every
 * page. A sender with a window sends it and then waits for a grant, which is a round trip away,
 * so one stream carries at most a window per round trip whatever the link can do. A home 100 ms
 * from the Computer each way got 8 MiB in 6.8 s, 1.24 MB/s, against the 1.31 MB/s that 256 KiB
 * every fifth of a second comes to; with this window the same page takes 1.1 s
 * (`apps/desktop/src/main/egress.test.ts`, "a page from far away"). In yamux that number is only where a stream starts: its
 * setting `MaxStreamWindowSize` (v0.1.2 `mux.go`; `stream.go` `sendWindowUpdate` takes a
 * stream's window up to it) is how a far link is given more. This protocol's window is one
 * number that does not change, so it is set where a far home is still fast: two mebibytes every
 * fifth of a second is 10 MB/s, more than most homes send.
 *
 * What it costs is memory, and only for a stream that is stuck: a receiver holds for one stream
 * what its socket has not taken, at most a window, so a connection whose site or whose browser
 * has stopped reading now holds up to 2 MiB where it held 256 KiB, at the desktop app or on the
 * Computer. A connection that is read holds next to nothing at either size.
 *
 * The other numbers were looked at again with it. A frame (`EGRESS_FRAME_LIMIT`) is half a
 * window and need not change. The queues toward a slow link (the desktop app's `QUEUE_BOUND`,
 * the server's `QUEUE_LIMIT`, one mebibyte each) are now less than one window, which is right:
 * they bound what waits in one socket for the link to take it, the window bounds what is on its
 * way from end to end, and a link that is slower than its sender is paced by the first whatever
 * the second allows. The budgets are below.
 */
export const EGRESS_WINDOW = 2 * 1024 * 1024

/** A receiver grants once its socket has taken this much: half the window, as yamux does. */
export const EGRESS_GRANT = EGRESS_WINDOW / 2

/**
 * The most a receiver holds for one stream from a far end that ignores the window: sixteen
 * windows. A far end that keeps the window is never past one, so this is not reached by it.
 */
export const EGRESS_STREAM_BUDGET = 32 * 1024 * 1024

/**
 * The most a receiver holds for all the streams of one link: 96 MiB, forty-eight whole windows.
 *
 * With a window of 256 KiB this was 384 of them, more streams than a browser has, so a far end
 * that kept the window could not reach it. At two mebibytes it can, by having more than
 * forty-eight connections stuck with a whole window each at the same moment. That is left as it
 * is, and the number is not raised eightfold to restore the old margin: it is the memory of the
 * Person's desktop app and of their Computer, and 768 MiB held for a browser that has stopped
 * reading is the worse failure. Chromium opens at most 32 connections through one proxy
 * (`kDefaultMaxSocketsPerProxyChain`; recalled, not read for this change), WebSockets apart, so
 * a browser's ordinary connections, all stuck at once, hold 64 MiB. The stream that crosses
 * the bound is closed, and the others stay.
 */
export const EGRESS_LINK_BUDGET = 96 * 1024 * 1024

/**
 * How a dead link is found: the socket between a desktop app and the server (`EGRESS_PATH`).
 *
 * A computer that goes to sleep, or a network that drops, closes nothing: the socket stays open
 * at the other end for as long as TCP lets it, which with nothing being sent is for ever. The
 * server held such a socket as the Person's way out, the Computer's browser sent its connections
 * to it, and a second desktop app of the same Person waited behind it.
 *
 * So every `EGRESS_PING_MILLIS` the server asks each socket it holds, joined or parked or
 * waiting its turn, with a WebSocket ping, which every client answers by itself (RFC 6455,
 * section 5.5.2). It also sends `EGRESS_BEAT`, because a desktop app's socket is a web
 * `WebSocket`, which neither shows a ping to the app nor lets it send one: the beat is what the
 * app can see. Each end then keeps the same rule: a socket on which nothing at all has arrived
 * for `EGRESS_DEADLINE_MILLIS` is gone. The server ends it, which frees the Person's way out
 * for the next app; the app ends it and dials again.
 *
 * The numbers are those of the tunnel's other leg, the server's SSH connection to the Computer
 * (`apps/server/src/computers/ssh/link.ts`: a probe every fifteen seconds, three lost). The
 * Thread connection's five and ten seconds (`packages/client/rpc/src/rpc.ts`) were not taken:
 * that socket carries small messages, and this one carries pages. A ping to a home on a slow
 * line waits behind what is already on its way there, up to a mebibyte here and more in the
 * system's own buffers, and ten seconds is less than that takes at a megabit.
 */
export const EGRESS_PING_MILLIS = 15_000

/** How long a socket may bring nothing before it is gone: three pings (`EGRESS_PING_MILLIS`). */
export const EGRESS_DEADLINE_MILLIS = 3 * EGRESS_PING_MILLIS

/**
 * What the server sends a desktop app with each ping: one text message. Frames are binary, so
 * it is no frame, and an end that does not know it passes it over as it does any text.
 */
export const EGRESS_BEAT = 'beat'

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

/** How many more bytes a `Grant` allows: unsigned 32 bits, and never nothing. */
export const EgressCredit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0xffff_ffff }))

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
 * - `Grant`: the sender of this frame has passed `bytes` more of this stream on to the stream's
 *   own socket, and the far end may send that many more ("How much a hop may hold"). It is
 *   Vivid's addition, like `End`, and is passed over by a client that does not know it.
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
  Grant: { stream: EgressStream, bytes: EgressCredit },
  Close: { stream: EgressStream },
})
export type EgressFrame = typeof EgressFrame.Type

/**
 * The kind byte of each frame: the reference's own numbers, then four for `End` and five for
 * `Grant`. A number is never given a second meaning: both ends of a link may be different
 * builds.
 */
const KIND = { Open: 1, Data: 2, Close: 3, End: 4, Grant: 5 } as const

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
    Grant: ({ stream, bytes: credit }) => {
      const bytes = headed(KIND.Grant, stream, 4)
      new DataView(bytes.buffer).setUint32(HEAD, credit)
      return bytes
    },
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
 * - `Short` and `Unknown`: too few bytes to say which stream or how much is granted, a grant of
 *   nothing, or a kind this side does not know.
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

/** A grant's four bytes. Cut short, or allowing nothing, it is not a grant, and is passed over. */
const decodeGrant = (
  stream: EgressStream,
  view: DataView,
): Result.Result<EgressFrame, EgressRefusal> => {
  const credit = view.byteLength < HEAD + 4 ? 0 : view.getUint32(HEAD)
  return credit === 0
    ? Result.fail(EgressRefusal.cases.Short.make({}))
    : Result.succeed(EgressFrame.cases.Grant.make({ stream, bytes: credit }))
}

/** An open's port and host. The stream is known, so one that names no place is `Unopenable`. */
const decodeOpen = (
  stream: EgressStream,
  bytes: Uint8Array,
  view: DataView,
): Result.Result<EgressFrame, EgressRefusal> => {
  const unopenable = Result.fail(EgressRefusal.cases.Unopenable.make({ stream }))
  const named = bytes.subarray(HEAD + 2)
  // The length is checked before a string is made of the bytes.
  if (bytes.length < HEAD + 2 || named.length > HOST_LIMIT) return unopenable
  const port = view.getUint16(HEAD)
  const host = String.fromCharCode(...named)
  if (port === 0 || !isHost(host)) return unopenable
  return Result.succeed(EgressFrame.cases.Open.make({ stream, host, port }))
}

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
  if (kind === KIND.Grant) return decodeGrant(stream, view)
  if (kind === KIND.Open) return decodeOpen(stream, bytes, view)
  return Result.fail(EgressRefusal.cases.Unknown.make({ kind }))
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
