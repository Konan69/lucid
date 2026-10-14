import { expect, it } from '@effect/vitest'
import { Result } from 'effect'
import {
  EGRESS_FRAME_LIMIT,
  EGRESS_PAYLOAD_LIMIT,
  EgressFrame,
  EgressRefusal,
  EgressStream,
  decodeEgressFrame,
  egressData,
  encodeEgressFrame,
} from './egress.js'

const stream = EgressStream.make(0x0102_0304)

/** The bytes are the reference's: kind, stream number, then port and host for an open. */
it('writes an open as kind 1, the stream, the port and the host', () => {
  const bytes = encodeEgressFrame(
    EgressFrame.cases.Open.make({ stream, host: 'vivid.example', port: 443 }),
  )
  expect([...bytes.subarray(0, 7)]).toEqual([1, 1, 2, 3, 4, 0x01, 0xbb])
  expect(String.fromCharCode(...bytes.subarray(7))).toBe('vivid.example')
})

it('reads back every kind of frame it writes', () => {
  const payload = Uint8Array.from([0, 255, 10, 13])
  const frames = [
    EgressFrame.cases.Open.make({ stream, host: 'xn--bcher-kva.example', port: 8080 }),
    EgressFrame.cases.Data.make({ stream, payload }),
    EgressFrame.cases.End.make({ stream }),
    EgressFrame.cases.Grant.make({ stream, bytes: 0xffff_ffff }),
    EgressFrame.cases.Close.make({ stream }),
  ]
  expect(frames.map((frame) => decodeEgressFrame(encodeEgressFrame(frame)))).toEqual(
    frames.map((frame) => Result.succeed(frame)),
  )
})

/**
 * The reference's three kinds keep their numbers, and so does each kind added since: the two
 * ends of a link may be different builds, so a number in use is never given another meaning.
 */
it('writes data as kind 2, a close as kind 3, an end as kind 4 and a grant as kind 5', () => {
  expect([
    encodeEgressFrame(EgressFrame.cases.Data.make({ stream, payload: Uint8Array.from([9]) })),
    encodeEgressFrame(EgressFrame.cases.Close.make({ stream })),
    encodeEgressFrame(EgressFrame.cases.End.make({ stream })),
    encodeEgressFrame(EgressFrame.cases.Grant.make({ stream, bytes: 0x0002_0000 })),
  ]).toEqual([
    Uint8Array.from([2, 1, 2, 3, 4, 9]),
    Uint8Array.from([3, 1, 2, 3, 4]),
    Uint8Array.from([4, 1, 2, 3, 4]),
    Uint8Array.from([5, 1, 2, 3, 4, 0, 2, 0, 0]),
  ])
})

it('a grant that is cut short, or allows nothing, is passed over', () => {
  const short = Result.fail(EgressRefusal.cases.Short.make({}))
  expect(decodeEgressFrame(Uint8Array.from([5, 1, 2, 3, 4, 0, 2, 0]))).toEqual(short)
  expect(decodeEgressFrame(Uint8Array.from([5, 1, 2, 3, 4, 0, 0, 0, 0]))).toEqual(short)
})

const refused = (bytes: Uint8Array) => Result.flip(decodeEgressFrame(bytes))

it('says why bytes are not a frame', () => {
  expect(refused(Uint8Array.from([2, 0, 0]))).toEqual(
    Result.succeed(EgressRefusal.cases.Short.make({})),
  )
  expect(refused(Uint8Array.from([9, 0, 0, 0, 1]))).toEqual(
    Result.succeed(EgressRefusal.cases.Unknown.make({ kind: 9 })),
  )
  const unopenable = Result.succeed(
    EgressRefusal.cases.Unopenable.make({ stream: EgressStream.make(1) }),
  )
  // An open with no port, one whose port is zero, one with no host, and one whose host has a
  // byte outside printable ASCII.
  expect(refused(Uint8Array.from([1, 0, 0, 0, 1, 0]))).toEqual(unopenable)
  expect(refused(Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 97]))).toEqual(unopenable)
  expect(refused(Uint8Array.from([1, 0, 0, 0, 1, 0, 80]))).toEqual(unopenable)
  expect(refused(Uint8Array.from([1, 0, 0, 0, 1, 0, 80, 97, 0xc3, 0xbc]))).toEqual(unopenable)
})

it('refuses an open far longer than any host without throwing', () => {
  const bytes = new Uint8Array(200_000).fill(97)
  bytes.set([1, 0, 0, 0, 1, 0, 80])
  expect(refused(bytes)).toEqual(
    Result.succeed(EgressRefusal.cases.Unopenable.make({ stream: EgressStream.make(1) })),
  )
  // The longest host there is, and one byte more.
  const longest = bytes.subarray(0, 7 + 255)
  expect(Result.isSuccess(decodeEgressFrame(longest))).toBe(true)
  expect(refused(bytes.subarray(0, 7 + 256))).toEqual(
    Result.succeed(EgressRefusal.cases.Unopenable.make({ stream: EgressStream.make(1) })),
  )
})

it('refuses a message longer than a frame, whatever its kind', () => {
  const data = new Uint8Array(EGRESS_FRAME_LIMIT + 1)
  data[0] = 2
  expect(refused(data)).toEqual(
    Result.succeed(EgressRefusal.cases.Oversized.make({ size: EGRESS_FRAME_LIMIT + 1 })),
  )
  expect(Result.isSuccess(decodeEgressFrame(data.subarray(0, EGRESS_FRAME_LIMIT)))).toBe(true)
})

it('cuts more bytes than a frame holds into frames that are read back in order', () => {
  const payload = Uint8Array.from({ length: EGRESS_PAYLOAD_LIMIT * 2 + 3 }, (_, at) => at % 251)
  const frames = egressData(stream, payload)
  expect(frames.map((frame) => frame.length)).toEqual([EGRESS_FRAME_LIMIT, EGRESS_FRAME_LIMIT, 8])
  const read = frames.flatMap((frame) => {
    const data = Result.getOrThrow(decodeEgressFrame(frame))
    return EgressFrame.guards.Data(data) ? Array.from(data.payload) : []
  })
  expect(read).toEqual(Array.from(payload))
  expect(egressData(stream, new Uint8Array(0))).toEqual([])
})
