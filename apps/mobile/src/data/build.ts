import { Data, Option } from 'effect'

/**
 * Which JavaScript this phone is running, for a Person who was told an update is on its way and
 * wants to know whether it has arrived.
 *
 * An installed app carries the JavaScript it was built with, and takes newer JavaScript from its
 * Vivid over the air (`update.ts`). So "which build is this" has two answers: the app's version,
 * which only a new install changes, and the update it is running, which changes whenever one
 * lands. A Person had no way to see the second, and could not tell an update that had not arrived
 * from one that had arrived and changed nothing they could see.
 */
export type Running = Data.TaggedEnum<{
  /** A build that asks nobody for updates: a development build, or one given no server. */
  Off: {}
  /** The JavaScript the app was installed with. No update has started on this phone yet. */
  Installed: {}
  /** JavaScript delivered since the install: when its server published it, and its own id. */
  Updated: { readonly published: Date; readonly id: string }
  /** An update is running and the update client did not say which. */
  Unnamed: {}
}>
export const Running = Data.taggedEnum<Running>()

/** What the update client says about the JavaScript that is running. */
export interface Reported {
  readonly enabled: boolean
  /** The running JavaScript is the copy inside the installed app. */
  readonly embedded: boolean
  readonly published: Option.Option<Date>
  readonly id: Option.Option<string>
}

/**
 * Reads the client's report. An embedded launch has a date and an id too (the build's own), which
 * are not an update's, so they are not shown as one.
 */
export const runningFrom = (reported: Reported): Running => {
  if (!reported.enabled) return Running.Off()
  if (reported.embedded) return Running.Installed()
  return Option.match(Option.all({ published: reported.published, id: reported.id }), {
    onNone: () => Running.Unnamed(),
    onSome: (named) => Running.Updated(named),
  })
}

/**
 * An update's id as it is said: its first eight characters, which is how one is quoted when two
 * people compare what they are running. The whole id is a UUID nobody reads.
 */
export const shortId = (id: string): string => id.slice(0, 8)

/**
 * The line Settings shows for what is running. The moment is written with its date whatever the
 * day, in the phone's own clock: it is compared with a time someone else said, so "9:12" alone,
 * which could be this morning or last week, would not do.
 */
export const runningWords = (running: Running, write: (moment: Date) => string): string =>
  Running.$match(running, {
    Off: () => 'This build does not take updates.',
    Installed: () => 'None yet. This is the app as it was installed.',
    Updated: ({ published, id }) => `Published ${write(published)} · ${shortId(id)}`,
    Unnamed: () => 'An update is running, but this phone cannot say which.',
  })
