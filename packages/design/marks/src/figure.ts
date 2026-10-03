/**
 * The drawn figures a mark is built from.
 *
 * Both surfaces draw SVG, but through different element namespaces: the web uses the DOM's
 * lowercase elements and the native app uses `react-native-svg`'s capitalised components. Sharing
 * a rendered component across the two is therefore impossible, so the geometry lives here as data
 * and each surface owns one thin renderer that maps a figure to its own primitive. Before this the
 * same paths were transcribed twice and could drift silently.
 */

/** Every mark is authored on the same 24x24 grid, so a row of them lines up without per-mark nudges. */
export const MARK_VIEW_BOX = '0 0 24 24'

/**
 * One drawn figure. `opacity` is carried on a path because it is a continuous value rather than a
 * distinct state — 1 is opaque, not a stand-in for a missing decision. A stroked circle is its own
 * `ring` variant instead of a circle with optional stroke fields, because a width without a colour
 * paints nothing and the pair must never come apart.
 */
export type MarkFigure =
  | {
      readonly kind: 'rect'
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
      readonly radius: number
      readonly fill: string
    }
  | {
      readonly kind: 'path'
      readonly d: string
      readonly fill: string
      readonly opacity: number
      readonly transform?: string
    }
  | {
      readonly kind: 'circle'
      readonly cx: number
      readonly cy: number
      readonly r: number
      readonly fill: string
    }
  | {
      readonly kind: 'ring'
      readonly cx: number
      readonly cy: number
      readonly r: number
      readonly fill: string
      readonly stroke: string
      readonly strokeWidth: number
    }
  | {
      /** A centred text glyph. The typeface is the surface's, because the two platforms name
          their system font differently; only the character and its metrics are shared. */
      readonly kind: 'glyph'
      readonly x: number
      readonly y: number
      readonly text: string
      readonly fontSize: number
      readonly fontWeight: number
      readonly fill: string
    }

/**
 * A key for one figure inside its mark, derived from the geometry that makes it that figure. The
 * renderers draw a mark as a list, and React needs a key per item; deriving it from the content
 * rather than the position means the key survives editing the artwork above it. `service.test.ts`
 * holds the invariant that no mark contains two figures with the same key.
 */
export function figureKey(figure: MarkFigure): string {
  // Every kind is named, so a new figure variant fails lint and typecheck here until it has a key.
  switch (figure.kind) {
    case 'rect':
      return `rect:${figure.x},${figure.y},${figure.width},${figure.height}`
    case 'path':
      return `path:${figure.d}`
    case 'circle':
      return `circle:${figure.cx},${figure.cy},${figure.r}`
    case 'ring':
      return `ring:${figure.cx},${figure.cy},${figure.r}`
    case 'glyph':
      return `glyph:${figure.x},${figure.y},${figure.text}`
  }
}
