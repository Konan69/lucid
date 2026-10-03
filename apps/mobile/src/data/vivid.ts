import { Appearance, DEFAULT_APPEARANCE, Look } from '@vivid/contracts'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { door, useDoor } from './door'
import type { LiveData } from './live'
import type { Colors } from '../theme'

/**
 * What Vivid is called and how its face is drawn, for the whole app.
 *
 * The face is drawn on Home, in the drawer, in every Thread and on the door, by components that
 * share nothing but this atom. It is a device atom because the door draws the face before anyone
 * is signed in; a session keeps it current from its `WatchAppearance` query (`live.ts`), which is
 * the one source, so a change made here, on the web or by a Company admin shows on every face at
 * the same moment. When a session begins it is put back to Vivid as it ships, so one Person never
 * sees the name another gave it.
 */
export const vividAtom = Atom.keepAlive(Atom.make<Appearance>(DEFAULT_APPEARANCE))

/** Vivid's name and look as they are now. Re-renders only when one of them changes. */
export function useAppearance(): Appearance {
  return useDoor(vividAtom)
}

/** Puts the device back to Vivid as it ships: said when a session begins. */
export const forgetAppearance = () => door.set(vividAtom, DEFAULT_APPEARANCE)

/** The paint a face is drawn in: its fill, and the eyes that hold their contrast on that fill. */
export interface FacePaint {
  readonly fill: string
  readonly eyes: string
}

/**
 * The paint of a look in the theme in force. The accent face keeps the eyes the theme sets on its
 * primary; a chosen hue is the same fixed colour in every theme, with the fixed eye the web face
 * uses on it (`face-eye`). A hue the tokens do not carry fails to typecheck here.
 */
export const facePaintOf = (look: Look, colors: Colors): FacePaint =>
  Look.match(look, {
    Accent: () => ({ fill: colors.accent, eyes: colors['primary-foreground'] }),
    Hue: ({ hue }) => ({ fill: colors[`face-${hue}`], eyes: colors['face-eye'] }),
  })

/**
 * Saves a new appearance and shows it at once: the expectation renames and recolours Vivid on
 * every screen before the server has answered, and is taken back if the server refuses.
 */
export const saveAppearance = (data: LiveData, next: Appearance) =>
  data.change(
    (client) => client.SetAppearance(next),
    () => data.live.appearance.expect(() => next),
  )
