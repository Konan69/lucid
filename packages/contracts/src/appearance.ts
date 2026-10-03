import { Schema } from 'effect'
import { Workspace } from './companies.js'

/**
 * The fixed colours Vivid's face can be drawn in. They are the `face-*` hues of the design tokens
 * (`packages/design/tokens`), named here because the choice is stored and crosses the wire; each
 * client maps a hue to its own token, and a hue with no mapping fails that client's typecheck.
 */
export const FaceHue = Schema.Literals([
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'gray',
] as const)
export type FaceHue = typeof FaceHue.Type

/**
 * How Vivid's face is drawn.
 *
 * `Accent` is the face nobody has changed: it takes the accent of whichever theme is in force, so
 * it moves with the theme. `Hue` is a colour somebody chose, and it stays that colour in every
 * theme. They are two cases rather than an eleventh hue called "accent" because the accent is not
 * a colour: it is "whatever the theme says".
 *
 * The reference this was adapted from (ChatGPT's "Customize your dot", `chooser-state` in the
 * decompiled webview) stores the same split as `color: 'authored'` against a named tint. Its
 * characters and pets are not cases here: they are drawn by a renderer and an account service
 * Vivid does not have, so a case for them would have nothing to show.
 */
export const Look = Schema.TaggedUnion({
  Accent: {},
  Hue: { hue: FaceHue },
})
export type Look = typeof Look.Type

/** The longest name Vivid can be given. The reference's nickname field allows the same. */
export const VIVID_NAME_MAX = 24

/**
 * What Vivid is called: 1 to 24 characters, with no space at either end, on one line and without
 * a backslash. The name is drawn in small headers and is said to the model as plain text, so a
 * line break or an escape has no honest meaning in it (the reference refuses backslashes too).
 * A client trims what was typed before it sends; the server refuses rather than repairs.
 */
export const VividName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isLengthBetween(1, VIVID_NAME_MAX),
  Schema.isPattern(/^[^\\\r\n]*$/),
)
export type VividName = typeof VividName.Type

/**
 * What Vivid is called and how its face is drawn, in one workspace.
 *
 * In a personal space it is the Person's own choice. In a Company it is the Company's: an owner or
 * admin sets it and everyone there sees the same Vivid, because they share one. It is never a
 * mix of the two; which one applies is decided by where the Person is working.
 */
export class Appearance extends Schema.Class<Appearance>('Appearance')(
  {
    name: VividName,
    look: Look,
  },
  { title: 'Appearance' },
) {}

/** Vivid as it is before anyone changes it: named Vivid, in the theme's accent. */
export const DEFAULT_APPEARANCE = new Appearance({
  name: 'Vivid',
  look: Look.cases.Accent.make({}),
})

/**
 * Whether someone working in this workspace may change Vivid there: always in their own space,
 * and in a Company only as its owner or an admin, because everyone in a Company shares one Vivid.
 * The server enforces this on `SetAppearance`; a client uses it to decide whether to offer the
 * way in at all.
 */
export const mayChangeAppearance = (workspace: Workspace): boolean =>
  Workspace.match(workspace, {
    Personal: () => true,
    Company: ({ role }) => role === 'owner' || role === 'admin',
  })
