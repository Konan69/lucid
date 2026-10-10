import { Effect } from 'effect'
import { forgetConversations } from './conversation'
import { forgetDrafts } from './drafts'
import { engine } from './runtime'
import { snapshots } from './snapshot'
import { start } from './app'

/**
 * The end of this browser's session, and the one thing that happens then, whatever ended it:
 * signing out here, the server refusing the session on any call (it expired, or was signed out
 * or revoked from another device), or the desktop app leaving its server.
 *
 * Everything the session was allowed to see leaves the browser: the first screen's snapshot is
 * taken off the screen and erased, writes of it that were pending are called off and none can
 * follow (`@vivid/state` `makeSnapshots`), saves of drafts on their way are called off, and
 * every draft the server has a copy of is forgotten (`forgetDrafts`), and the conversations
 * it had open are ended (`forgetConversations`). It ends once the store is
 * empty, so signing out can wait for it before the page reloads into the sign-in screen.
 *
 * Words a Person typed here that the server never took are the one thing kept: they exist
 * nowhere else, and are named for their Person, so nobody else is shown them.
 */
export const sessionEnded = Effect.suspend(() => {
  forgetDrafts()
  forgetConversations()
  return snapshots.ended
})

// The server refused this session, on whichever call it was asked. Heard once for every such
// answer; ending twice is ending once.
engine.whenSessionGone(() => {
  start(sessionEnded)
})
