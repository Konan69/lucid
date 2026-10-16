import { Schema } from 'effect'
import { DeviceAnswer, DeviceRefusal, SignInRead, WindowRefusal } from '@vivid/contracts'

/**
 * What the ledger knows about one dispatch to a Person's computer.
 *
 * A row starts `Dispatched` and moves once, to how it ended; nothing ever moves it back, which is
 * why a request cannot be sent twice. `OutcomeUnknown` is every ending without an answer: the
 * deadline passed, the computer went away, or the server stopped while it was waiting.
 *
 * The receipt deliberately has no room for a page. A `Done` answer carries the Person's signed-in
 * page to the Run that asked and is then gone; only the fact that it was done is kept.
 */
export const DeviceReceipt = Schema.TaggedUnion({
  Dispatched: {},
  Done: {},
  Refused: { reason: DeviceRefusal },
  Did: {},
  Declined: { reason: WindowRefusal },
  Failed: {},
  OutcomeUnknown: {},
})
export type DeviceReceipt = typeof DeviceReceipt.Type

/** The receipt an answer leaves behind: its kind and a refusal's reason, never its content. */
export const receiptOf = (answer: DeviceAnswer): DeviceReceipt =>
  DeviceAnswer.match(answer, {
    Done: (): DeviceReceipt => DeviceReceipt.cases.Done.make({}),
    Refused: ({ reason }): DeviceReceipt => DeviceReceipt.cases.Refused.make({ reason }),
    Did: (): DeviceReceipt => DeviceReceipt.cases.Did.make({}),
    Declined: ({ reason }): DeviceReceipt => DeviceReceipt.cases.Declined.make({ reason }),
    Failed: (): DeviceReceipt => DeviceReceipt.cases.Failed.make({}),
    // Only a collection completed the read. Source refusals are failures, without private data.
    SignIn: ({ read }): DeviceReceipt =>
      SignInRead.guards.Collected(read)
        ? DeviceReceipt.cases.Done.make({})
        : DeviceReceipt.cases.Failed.make({}),
  })

/**
 * One live link from a desktop app. A new link for the same Device gets a new identifier, so an
 * answer from a link that was replaced cannot settle a request sent on its successor.
 */
export const DeviceSubscriptionId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('DeviceSubscriptionId'),
)
export type DeviceSubscriptionId = typeof DeviceSubscriptionId.Type
