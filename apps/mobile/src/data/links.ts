import { Linking } from 'react-native'

/**
 * Opens a link in the phone's browser, and answers whether it could be. Only a web page is ever
 * handed over: Markdown is written by Vivid or pasted in by a Person, and a link in it to another
 * app's scheme would open that app.
 *
 * One door for both the app's own Markdown and a display's parts (`parts/text.tsx`,
 * `parts/markdown.tsx`), so a Person learns one way a link opens.
 */
export const openWebLink = (address: string): Promise<boolean> =>
  /^https?:\/\//iu.test(address)
    ? Linking.openURL(address).then(
        () => true,
        () => false,
      )
    : Promise.resolve(false)
