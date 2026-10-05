import { signInPage } from '@vivid/state'
import { Data, Option } from 'effect'
import { useMemo } from 'react'
import { Linking, View } from 'react-native'
import { onForeground } from '../../data/foreground'

/**
 * The trip to a provider's own sign-in page and back: the one time the phone app hands the
 * Person to the browser. The card in a Thread (`Card.tsx`) and the Integrations sheet
 * (`screen/settings/Integrations.tsx`) both make it, so the parts they share are here once and
 * each keeps its own words.
 */

/**
 * Where a sign-in stands, from this phone's side.
 *
 * - `Still`: nothing is in flight and there is nothing to say.
 * - `Opening`: the Person pressed Sign in, and the server is being asked for the provider's page.
 * - `Away`: that page was handed to the browser and the Person has not come back.
 * - `Checking`: they are back, and the server is being asked whether it went through.
 * - `Unfinished`: the server says the sign-in is still to do. Not an error: people look and leave.
 * - `Refused`: the page could not be opened, or the server would not say; its sentence.
 */
export type Trip = Data.TaggedEnum<{
  Still: {}
  Opening: {}
  Away: {}
  Checking: {}
  Unfinished: {}
  Refused: { readonly message: string }
}>
export const Trip = Data.taggedEnum<Trip>()

/**
 * Hands the provider's page to the phone's browser. The app has no browser of its own (it signs
 * a device in the same way), so the page goes to the system and the app goes to the background.
 *
 * The address is only ever opened when it is a web page (`signInPage`): handed to a phone as it
 * came, another app's scheme would open that app.
 *
 * `away` is said before the browser is asked for, so the caller is already listening for the
 * return (`Returning`) by the time the app leaves the front. `refused` is said with the sentence
 * to show: at once when the address is not a page, later when the browser would not take it.
 */
export function showSignIn(
  address: string,
  name: string,
  said: { readonly away: () => void; readonly refused: (message: string) => void },
) {
  const page = signInPage(address)
  if (Option.isNone(page)) {
    said.refused(`${name}’s sign-in page could not be opened.`)
    return
  }
  said.away()
  void Linking.openURL(page.value.href).then(
    () => undefined,
    () => said.refused(`${name}’s sign-in page could not be opened in your browser.`),
  )
}

/**
 * Hears the Person come back to the app. It draws nothing; being a component is what lets a
 * screen listen only while they are away at the provider's page, with no effect to run: the
 * subscription is this view's ref, and it ends when the view goes.
 */
export function Returning({ onReturn }: { onReturn: () => void }) {
  const heard = useMemo(() => onForeground(onReturn), [onReturn])
  return <View ref={heard} />
}
