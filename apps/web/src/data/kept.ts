import { Option } from 'effect'

/**
 * What this browser keeps between visits: a theme, the sidebar's width, unsent drafts.
 *
 * `localStorage` can refuse: a browser set to block site data throws on the first read, and a
 * full or private one throws on a write. Each of those used to be an uncaught exception, at
 * module load (the app never opened) or in the middle of sending a message (the words were
 * cleared and never sent). Keeping something is a convenience, so a refusal here is an answer
 * like any other: nothing was kept, or it was not written, and the caller carries on in memory.
 */
export const kept = {
  /** What is kept under a name, when the browser will say and something is. */
  read: (name: string): Option.Option<string> =>
    Option.flatMap(Option.liftThrowable(() => localStorage.getItem(name))(), Option.fromNullOr),
  /** Keeps a value under a name. Says whether the browser took it. */
  write: (name: string, value: string): boolean =>
    Option.isSome(Option.liftThrowable(() => localStorage.setItem(name, value))()),
  /** Forgets what is kept under a name. */
  remove: (name: string): boolean =>
    Option.isSome(Option.liftThrowable(() => localStorage.removeItem(name))()),
}
