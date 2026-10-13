import { expect, it } from '@effect/vitest'
import { Option } from 'effect'
import { EgressFrame, EgressStream, decodeEgressFrame, encodeEgressFrame } from './egress.js'

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
    EgressFrame.cases.Close.make({ stream }),
  ]
  expect(frames.map((frame) => decodeEgressFrame(encodeEgressFrame(frame)))).toEqual(
    frames.map(Option.some),
  )
})

it('reads nothing from bytes that are not a frame', () => {
  expect(decodeEgressFrame(Uint8Array.from([2, 0, 0]))).toEqual(Option.none())
  expect(decodeEgressFrame(Uint8Array.from([9, 0, 0, 0, 1]))).toEqual(Option.none())
  // An open with no port, and one whose port is zero.
  expect(decodeEgressFrame(Uint8Array.from([1, 0, 0, 0, 1, 0]))).toEqual(Option.none())
  expect(decodeEgressFrame(Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 97]))).toEqual(Option.none())
  // A host with a byte outside printable ASCII, and one with no host at all.
  expect(decodeEgressFrame(Uint8Array.from([1, 0, 0, 0, 1, 0, 80, 97, 0xc3, 0xbc]))).toEqual(
    Option.none(),
  )
  expect(decodeEgressFrame(Uint8Array.from([1, 0, 0, 0, 1, 0, 80]))).toEqual(Option.none())
})
