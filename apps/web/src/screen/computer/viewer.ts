import { Option } from 'effect'

/** The machine's screen in its own pixels. */
interface ScreenSize {
  readonly width: number
  readonly height: number
}

/** A whole number of pixels greater than zero, read from a viewer address. */
const pixels = (value: string | null) =>
  Option.filter(
    Option.map(Option.fromNullishOr(value), Number),
    (count) => Number.isInteger(count) && count > 0,
  )

/**
 * What a provider's viewer address says about the screen it shows: its `width` and `height` are
 * the machine's screen in pixels (Boat's Moonlight page, `stream.js`, reads the same two). An
 * address that does not say, or cannot be read, has no known shape.
 */
export const viewerResolution = (address: string): Option.Option<ScreenSize> => {
  if (!URL.canParse(address)) return Option.none()
  const asked = new URL(address).searchParams
  return Option.all({ width: pixels(asked.get('width')), height: pixels(asked.get('height')) })
}

/**
 * The viewer address this panel loads. The provider issues it with `theme=light`, which makes its
 * page white around the screen and while it connects; the machine's desk here is dark in both of
 * Vivid's themes, so the page is asked for its own default, which is dark (`stream.html` adds
 * `light` only when told to). Nothing else in the address is touched: the permission is in its
 * fragment.
 */
export const viewerOnDesk = (address: string) => {
  if (!URL.canParse(address)) return address
  const dark = new URL(address)
  dark.searchParams.delete('theme')
  return dark.href
}
