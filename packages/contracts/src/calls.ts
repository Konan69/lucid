import { Schema } from 'effect'

/**
 * Vivid rings the Person's phone and, once answered, holds a short live conversation. `opening`
 * is the first thing Vivid says; `brief` is what Vivid knows, so it can answer follow-up
 * questions on the call.
 */
export const PhoneCallRequest = Schema.Struct({
  opening: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(500)),
  brief: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
}).annotate({ identifier: 'PhoneCallRequest', title: 'Phone call request' })
/** Decoded phone call request. */
export interface PhoneCallRequest extends Schema.Schema.Type<typeof PhoneCallRequest> {}

/**
 * What a phone waiting for Vivid hears back: a call to ring with, or nothing yet. A phone keeps
 * waiting after `Quiet`, so the wait is bounded and the connection never idles out.
 */
export const RingWait = Schema.TaggedUnion({
  Ring: { call: PhoneCallRequest },
  Quiet: {},
})
/** Decoded ring wait. */
export type RingWait = typeof RingWait.Type
