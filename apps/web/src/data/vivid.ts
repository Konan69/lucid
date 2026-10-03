import {
  Appearance,
  DEFAULT_APPEARANCE,
  Look,
  mayChangeAppearance,
  type MeResponse,
} from '@vivid/contracts'
import { Option, Schema } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import { useSyncExternalStore } from 'react'
import type { FaceColor } from '../ui/Face'
import { change } from './app'
import { kept } from './kept'
import { engine } from './runtime'
import '../styles/vivid.css'

/**
 * What Vivid is called and how its face is drawn, live, for the whole app.
 *
 * There is one source: the `WatchAppearance` query, held open for as long as the page is. Every
 * screen that names Vivid or draws its face reads it from here, so a change (made on this device,
 * on another one, or by a Company admin) shows everywhere at the same moment.
 *
 * The last answer is remembered on this device, the way the theme is, so a reload draws Vivid as
 * the Person left it instead of flashing the stock face while the socket connects.
 *
 * `ui/Face.tsx` reads it for every face that is not given a colour or an outline of its own.
 */

const KEY = 'vivid-appearance'
const AppearanceJson = Schema.fromJsonString(Appearance)
const decodeKept = Schema.decodeUnknownOption(AppearanceJson)
const encodeKept = Schema.encodeSync(AppearanceJson)

/** What this browser last saw, when it kept something it still understands. */
const remembered = (): Appearance =>
  Option.getOrElse(Option.flatMap(kept.read(KEY), decodeKept), () => DEFAULT_APPEARANCE)

let shown = remembered()
const listeners = new Set<() => void>()

/** The colour a look draws the face in. A hue the web face cannot draw fails to typecheck here. */
export const faceColorOf = (look: Look): FaceColor =>
  Look.match(look, {
    Accent: () => 'accent' as const,
    Hue: ({ hue }) => hue,
  })

const adopt = (next: Appearance) => {
  if (
    next.name === shown.name &&
    next.outline === shown.outline &&
    faceColorOf(next.look) === faceColorOf(shown.look)
  )
    return
  shown = next
  kept.write(KEY, encodeKept(next))
  for (const listener of listeners) listener()
}

/** The live query. An expected change (`saveAppearance`) flows through it like a server result. */
export const appearance = engine.query((client) => client.WatchAppearance())

// Held open for the life of the page, so every face has the answer before it is first drawn. It answers again when the Person changes workspace (`data/live`
// reopens every query), which is how a Company's Vivid replaces the Person's own.
engine.registry.subscribe(
  appearance.atom,
  (result) => {
    if (AsyncResult.isSuccess(result)) adopt(result.value)
  },
  { immediate: true },
)

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Vivid's name and look as they are now. Re-renders only when one of them changes. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => shown)
}

/** Whether this Person may change Vivid where they are working (`mayChangeAppearance`). */
export const mayCustomise = (me: MeResponse): boolean => mayChangeAppearance(me.workspace)

/**
 * Saves a new appearance and shows it at once: the expectation recolours and renames Vivid on
 * every surface before the server has answered, and is taken back if the server refuses.
 */
export const saveAppearance = (next: Appearance) =>
  change(
    (client) => client.SetAppearance(next),
    () => appearance.expect(() => next),
  )
