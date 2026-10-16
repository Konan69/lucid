import { Commit, ServerBuild, shortCommit } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import * as Atom from 'effect/reactivity/Atom'

/**
 * Which build of Vivid is on screen, for a Person who was told a change is merged or deployed
 * and wants to see whether what is in front of them has it (`@vivid/contracts` `build.ts`).
 *
 * Three things answer that here, because a page and its server can differ. The page's own build
 * is written in when it is built (`define` in `vite.config.ts`). The server's is asked of the
 * server (`live.build`). The desktop app carries its own copy of the page, so it also says its
 * own version. The phone says the same about itself in its own Settings (`apps/mobile`
 * `data/build.ts`).
 */

/** The commit this page was built from; empty when its build was given none. */
declare const __VIVID_COMMIT__: string
/** When this page's build ran, as an ISO 8601 moment. */
declare const __VIVID_BUILT__: string

/** This page's build: its commit when it has one, and when it was built. */
export const page = {
  commit: Schema.decodeUnknownOption(Commit)(__VIVID_COMMIT__),
  built: new Date(__VIVID_BUILT__),
}

/**
 * A moment with its date and its time ("16 Oct, 14:02"), whatever the day: it is compared with a
 * time someone else said, the moment a change was merged, so "14:02" alone would not do. The
 * phone writes its update's moment the same way (`apps/mobile/src/data/running.ts`).
 */
const moment = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
})

/** The line Settings shows for this page's build. */
export const pageWords = Option.match(page.commit, {
  onNone: () => `Built ${moment.format(page.built)}, no commit named`,
  onSome: (commit) => `${shortCommit(commit)}, built ${moment.format(page.built)}`,
})

/** The line Settings shows for the server's build. */
export const serverWords = (build: ServerBuild): string =>
  ServerBuild.match(build, {
    Named: ({ commit }) => shortCommit(commit),
    Unnamed: () => 'No commit named',
  })

/**
 * The desktop app's version, asked of its bridge once. In a browser tab there is no desktop app
 * and so no such version. The bridge answers with a Promise; a rejection is the shell itself
 * broken, not an answer, as `computers.ts` reads the same bridge.
 */
export const desktopVersion = Option.map(
  'vivid' in globalThis ? Option.some(globalThis.vivid) : Option.none(),
  (bridge) => Atom.make(Effect.promise(() => bridge.getAppVersion())),
)
