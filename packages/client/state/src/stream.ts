import { Following } from './conversation.js'
import { Predicate } from 'effect'
import { LiveState } from './live.js'

/**
 * What a conversation's link is doing, read from the conversation's own live query
 * (`conversation.ts`).
 *
 * A conversation arrives over the app's socket as a `WatchConversation` subscription, and every
 * interruption of it mends by itself: the subscription is opened again and begins with the
 * conversation whole. Said as they come, a deploy, a phone that slept or a change of network
 * would each put a sentence on the screen for a fault that is over in a second. Production on
 * 13 October 2026 cut every open conversation twelve times in two days, once per deploy.
 *
 * - `Flowing`: nothing is wrong.
 * - `CatchingUp`: the link ended or broke and is being opened again (`Following.Behind`). What
 *   was last known is still drawn, and nothing is lost: the next link begins with the state
 *   whole.
 * - `Cut`: the server refused the conversation in a way asking again cannot change, or this
 *   client's own words did not arrive. Only the Person moves it: by opening it again, or by
 *   sending the words again.
 */
export type Reading = 'Flowing' | 'CatchingUp' | 'Cut'

/**
 * Whether the server refused a conversation for its size (`ConversationTooLarge`,
 * `@vivid/contracts`). It reads as `Cut` like any refusal, and is said in its own words: the
 * server can be reached, and opening it again would be refused the same way.
 */
export const isTooLong = (conversation: LiveState<Following>): boolean =>
  LiveState.$is('Failed')(conversation) &&
  Predicate.isTagged(conversation.failure, 'ConversationTooLarge')

/** What a Person is told about a conversation that is too long to open, on every surface. */
export const TOO_LONG = 'This thread is too long to open. Start a new thread to carry on.'

/**
 * The link's reading from the conversation's query. `unsent` is that words sent from here, and
 * drawn in the conversation, did not arrive (`sending.unsentIn` in a Thread that draws its own
 * words ahead): it read as `Cut` when sending was Flue's hook (Flue React 2.2.2 `converge`
 * raised the hook's one `error` for a failed send as for a stream it had given up on), and it
 * still does, so a screen says the same thing about it.
 */
export const readingOf = (
  conversation: LiveState<Following>,
  at: { readonly unsent: boolean },
): Reading =>
  LiveState.$match(conversation, {
    Loading: (): Reading => (at.unsent ? 'Cut' : 'Flowing'),
    Failed: (): Reading => 'Cut',
    Ready: ({ value }): Reading => {
      if (at.unsent) return 'Cut'
      return Following.$is('Behind')(value) ? 'CatchingUp' : 'Flowing'
    },
  })

/**
 * How long a link may be catching up before a screen says so while the app's own socket is
 * open. A lost link is opened again for ever (`following`, `conversation.ts`: only a refusal
 * that asking cannot change stops it), so a conversation that stays out of reach would otherwise
 * never be said. Twenty seconds is past a deploy, the longest ordinary break: production's
 * replaced runtime refused conversations for about ten seconds (13 October 2026, 12:08:04 to
 * 12:08:16 UTC).
 */
export const QUIET_MS = 20_000

/**
 * Whether a screen says anything about the link. A link that is catching up is said when the
 * app's own socket is down as well, since then the server really is out of reach, or when it has
 * been catching up for longer than `QUIET_MS` (`lasting`). Before that the break is usually over
 * before a sentence could be read.
 */
export const streamSaid = (
  reading: Reading,
  at: { readonly socketLost: boolean; readonly late: boolean },
): boolean => reading === 'Cut' || (reading === 'CatchingUp' && (at.socketLost || at.late))

/**
 * Whether something has held for `ms`, as an external store a screen reads with
 * `useSyncExternalStore`: made anew each time `on` changes, it starts its one timer when it is
 * subscribed to and answers `true` once the time has passed. No effect hook and nothing set
 * during a render; a store that is let go clears its timer.
 */
export const lasting = (on: boolean, ms: number) => {
  let late = false
  return {
    subscribe: (heard: () => void) => {
      if (!on) return () => undefined
      const timer = setTimeout(() => {
        late = true
        heard()
      }, ms)
      return () => clearTimeout(timer)
    },
    read: () => late,
  }
}
