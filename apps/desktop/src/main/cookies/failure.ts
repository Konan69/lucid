import { CopySignInOutcome, SignInBrowser } from '@vivid/contracts'
import { Option, Schema } from 'effect'

/** Read only known OS fields. Original messages can contain paths or cookie values and are
 * deliberately discarded. SQLite's low byte retains the primary code of an extended error. */
const OperatingFailure = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  errcode: Schema.optionalKey(Schema.Int),
})
const decodeFailure = Schema.decodeUnknownOption(OperatingFailure)

/** Missing adapters, explicit OS denial and an unavailable key need different remedies.
 * A subprocess exit alone cannot prove that the operating system denied permission. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Process creation errors enter only through this errno decoder.
export const cookieKeyFailure = (browser: SignInBrowser, failure: unknown) => {
  const parsed = decodeFailure(failure)
  if (Option.isSome(parsed) && parsed.value.code === 'ENOENT')
    return CopySignInOutcome.cases.UnsupportedEncryption.make({ browser })
  if (Option.isSome(parsed) && (parsed.value.code === 'EACCES' || parsed.value.code === 'EPERM'))
    return CopySignInOutcome.cases.PermissionDenied.make({ browser })
  return CopySignInOutcome.cases.KeyUnavailable.make({ browser })
}

/** Map observed lock evidence to the one remedy that fixes it. A running browser or empty jar
 * is never evidence here. Source: node:sqlite SQLITE_BUSY(5)/SQLITE_LOCKED(6), libuv EBUSY. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- OS and SQLite errors enter here, and only their closed numeric and errno fields are inspected.
export const cookieReadFailure = (browser: SignInBrowser, failure: unknown) => {
  const parsed = decodeFailure(failure)
  if (Option.isNone(parsed)) return CopySignInOutcome.cases.Unreadable.make({ browser })
  const { code, errcode } = parsed.value
  const primary = errcode === undefined ? undefined : errcode & 0xff
  if (
    code === 'EBUSY' ||
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    primary === 5 ||
    primary === 6
  )
    return CopySignInOutcome.cases.BrowserLocked.make({ browser })
  if (code === 'EACCES' || code === 'EPERM')
    return CopySignInOutcome.cases.PermissionDenied.make({ browser })
  if (code === 'ENOENT') return CopySignInOutcome.cases.SourceMissing.make({ browser })
  return CopySignInOutcome.cases.Unreadable.make({ browser })
}
