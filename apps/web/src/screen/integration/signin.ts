import { Option } from 'effect'

/**
 * A provider's sign-in address, when it is one a browser should be sent to. The address comes
 * from the Connection layer and ends up in a tab, so anything that is not a web page (a script
 * address, another app's scheme, something that does not parse) is treated as no address at all.
 */
const signInPage = (address: string) =>
  Option.filter(
    Option.liftThrowable((value: string) => new URL(value))(address),
    (page) => page.protocol === 'https:' || page.protocol === 'http:',
  )

/**
 * Sends the tab that was opened for a sign-in to the provider's page. The tab was opened by the
 * click itself, before the server was asked anything, because a browser only lets a page open a
 * tab while it is still handling the click. Without a tab or a real address there is nothing to
 * show, and the caller says so.
 */
export function showSignIn(tab: Window | null, address: string) {
  const page = signInPage(address)
  if (tab === null || Option.isNone(page)) {
    if (tab !== null) tab.close()
    return false
  }
  // The provider's page must not be able to reach back into this one.
  tab.opener = null
  tab.location.replace(page.value.href)
  return true
}
