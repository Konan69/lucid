import { Option } from 'effect'

/**
 * A provider's sign-in address, when it is one a browser should be sent to. The address comes
 * from the Connection layer and is handed to a browser (a tab on the web, the phone's own browser
 * in the app), so anything that is not a web page is treated as no address at all: a script
 * address, something that does not parse, or another app's scheme, which on a phone would open
 * that app instead of a page.
 */
export const signInPage = (address: string): Option.Option<URL> =>
  Option.filter(
    Option.liftThrowable((value: string) => new URL(value))(address),
    (page) => page.protocol === 'https:' || page.protocol === 'http:',
  )
