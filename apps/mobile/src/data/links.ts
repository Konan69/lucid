import { NotificationOpens, ThreadId } from '@vivid/contracts'
import { Option, Schema } from 'effect'
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

const decodeThread = Schema.decodeUnknownOption(ThreadId)

/**
 * Where a `vivid://` link opens, in the same terms a pressed notification uses: a Thread
 * (`vivid://thread/<id>`, what the Live Activity's rows link to) or the Feed (`vivid://feed`).
 * Any other link, the sign-in return among them, is not this listener's and opens nothing.
 */
const opensOf = (link: string): Option.Option<NotificationOpens> => {
  const thread = /^vivid:\/\/thread\/([^/?#]+)/u.exec(link)
  if (thread !== null)
    return Option.map(
      Option.flatMap(Option.fromUndefinedOr(thread[1]), (id) =>
        decodeThread(decodeURIComponent(id)),
      ),
      (threadId) => NotificationOpens.cases.Thread.make({ threadId }),
    )
  return /^vivid:\/\/feed(?:[/?#]|$)/u.test(link)
    ? Option.some(NotificationOpens.cases.Feed.make({}))
    : Option.none()
}

/**
 * Hears `vivid://` links and hands where each opens to `open`, the same opener notification
 * presses use (`App.tsx` `usePressedNotifications`). A link that started the app is read once at
 * that moment; later links arrive as they happen.
 */
export const listenForLinks = (open: (opens: NotificationOpens) => void) => {
  void Linking.getInitialURL().then((link) => {
    if (link !== null) Option.map(opensOf(link), open)
  })
  const heard = Linking.addEventListener('url', ({ url }) => {
    Option.map(opensOf(url), open)
  })
  return () => heard.remove()
}
