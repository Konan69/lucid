import { googlePlace } from '@vivid/state'
import type { ServerAddress } from './server'

/**
 * The page this phone opens in the system browser to sign in with Google: the approval page for
 * its code, marked so the web starts Google sign-in at once when nobody is signed in there
 * (`googlePlace` in `@vivid/state`, which the desktop app opens too, on its own server's origin).
 *
 * The phone has no way to run Google's sign-in inside the app without a native browser module,
 * which the installed app does not carry. So it borrows the browser's: the Person signs in with
 * Google on the web, lands on the approval page with this phone's code already filled in, and
 * approves it. The code exchange this phone is already running then hands it a session of its
 * own. A browser that is already signed in skips Google and opens straight on the approval.
 */
export const googleAddress = (server: ServerAddress, userCode: string): string =>
  `${server}${googlePlace(userCode)}`
