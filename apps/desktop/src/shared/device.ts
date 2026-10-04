import * as Schema from 'effect/Schema'

/**
 * The server's identifier for this computer's Device record. It names the record and proves
 * nothing, so the renderer may have it: the app's installation identity, which does prove
 * something, never leaves the main process. The server brands this value as `DeviceId`; the
 * bridge carries it as the same text, without the contracts package in the sandboxed preload.
 */
const LinkedDevice = Schema.String.check(Schema.isUUID())

/**
 * What this computer is to Vivid right now, as the desktop app last heard it from the server.
 *
 * Enrolling grants nothing: a computer waits until its Person allows it, listens only while it is
 * allowed, and stops the moment it is revoked or its Person signs out.
 */
export const DeviceLink = Schema.TaggedUnion({
  /** No server is chosen, or nobody is signed in on it. */
  SignedOut: {},
  /** The server could not be reached; the app is trying again. */
  Unreachable: {},
  /** Enrolled, and waiting for its Person to allow it. */
  Waiting: { device: LinkedDevice },
  /** Allowed and listening: Vivid can act in this app's Browser. */
  Linked: { device: LinkedDevice },
  /** Its Person took access away. */
  Revoked: { device: LinkedDevice },
})
export type DeviceLink = typeof DeviceLink.Type

/** What the app's own document may know and do about this computer's link. */
export interface VividDeviceBridge {
  /** The link as the desktop app last heard it. */
  readonly get: () => Promise<DeviceLink>
  /**
   * Asks the server again now, after the Person allowed or revoked this computer, and answers
   * with what the app knew when asked. It never interrupts a link that is listening.
   */
  readonly refresh: () => Promise<DeviceLink>
}
