import { tagSchemaId } from '@openuidev/react-lang'
import { createContext, useContext } from 'react'
import { z } from 'zod/v4'
import { useTheme, type Colors } from '../theme'

/**
 * The parts' shared prop schemas and the skin over them, for the phone. Every schema here is
 * copied exactly from the web's vendored sources (`apps/web/vendor/openui/style.ts`): the schema
 * is the model-facing vocabulary, and a difference between surfaces would make a display the
 * model wrote for one decode differently on the other. `library.test.ts` holds the phone's spec
 * against the runtime's `parts.json`, which the web's library was generated from, so drift fails
 * a test rather than a Person's display.
 *
 * The value helpers (`fg`, `bgOf`, `radiusOf`, `space`, `sizeOf`) are the phone's reading of the
 * web's skin (`apps/web/src/parts/skin.css`): a display sits on a tint of Vivid's colour, what it
 * holds is raised on that tint, a chart is one family of Vivid's colour, and status colours read
 * from the theme in force. The web mixes in oklab in CSS; the phone mixes the same proportions in
 * plain sRGB here, which lands within a step of the web's result for these few tints.
 */

// Safety
// A model-written style value could otherwise name a resource. CSS has no meaning on the phone,
// so nothing model-written is ever read as CSS here; only plain colours pass through, checked the
// same way the web checks them before it lets them into a style.
const UNSAFE_CSS = /(url|image|image-set|cross-fade|element|expression|paint|var|attr|env)\s*\(|@import|[\\;{}<>]/i
const isSafeColor = (value: string) => !UNSAFE_CSS.test(value)

/** An absolute http(s) URL, or null. Relative URLs would resolve against the app. */
export function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  try {
    const protocol = new URL(trimmed).protocol
    return protocol === 'http:' || protocol === 'https:' ? trimmed : null
  } catch {
    return null
  }
}

// Shared prop schemas
/** Children slot: any component, or a list of them (from @Each). Printed as `Node[]`. */
const node = z.any()
tagSchemaId(node, 'Node')
export const children = z.array(node)

/** A token or a plain colour. Printed once as `Color` and explained in the prompt notes. */
export const color = z.string()
tagSchemaId(color, 'Color')

/** A px number or a CSS length such as "50%". Printed as `Length`. */
export const length = z.union([z.number(), z.string()])
tagSchemaId(length, 'Length')

export const radiusSchema = z.union([z.enum(['sm', 'md', 'lg', 'xl', 'full']), z.number()])
tagSchemaId(radiusSchema, 'Radius')

export const option = z.union([z.string(), z.object({ value: z.string(), label: z.string() })])
export type Option = z.infer<typeof option>
export const toOption = (o: Option) => (typeof o === 'string' ? { value: o, label: o } : o)

// Colours

const STATUS = ['info', 'success', 'warning', 'danger', 'purple', 'pink'] as const

/**
 * One colour of the chart's family: the web's skin draws a chart as one colour in six strengths
 * (`apps/web/src/parts/skin.css`, `--iui-chart-1` through `--iui-chart-6`), mixed over the sheet
 * the display sits on. The same proportions, mixed in sRGB.
 */
export function chartColors(accent: string, sheet: string, faint: string, ink: string): [
  string,
  string,
  string,
  string,
  string,
  string,
] {
  return [
    accent,
    mix(accent, sheet, 0.62),
    mix(accent, sheet, 0.38),
    mix(accent, ink, 0.7),
    faint,
    mix(accent, sheet, 0.22),
  ]
}

/**
 * `p` of `a` over `b`, in sRGB: what CSS `color-mix(in srgb, a p%, b)` does. Handles the three
 * colour shapes a theme or a model writes: `#rgb`, `#rrggbb` and `rgb(a)`. Unknown shapes are
 * passed through unchanged — a colour the helper cannot read is still drawn, not refused.
 */
export function mix(a: string, b: string, weight: number): string {
  const left = channels(a)
  const right = channels(b)
  if (!left || !right) return a
  const over = left.map((channel, i) => Math.round(channel * weight + right[i] * (1 - weight)))
  return `rgb(${over[0]}, ${over[1]}, ${over[2]})`
}

function channels(value: string): [number, number, number] | null {
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(value)
  if (short) return short.slice(1, 4).map((d) => parseInt(d + d, 16)) as [number, number, number]
  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value)
  if (full) return full.slice(1, 4).map((d) => parseInt(d, 16)) as [number, number, number]
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return null
}

/**
 * Text color for a model-chosen colour background (hex or rgb). Raw colours do not follow the
 * theme, so text on them is set dark or light to stay legible. The web's threshold
 * (`apps/web/vendor/openui/style.ts`, `contrastOn`), in the same sRGB luminance.
 */
export function contrastOn(background: string): string | null {
  const rgb = channels(background.trim())
  if (!rgb) return null
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? '#0d0d0d' : '#ffffff'
}

/**
 * The display's own ink when it sits inside a Box filled with a raw model-chosen colour: dark or
 * light, fixed when the Box is drawn, so every word-part below it resolves to it. The web's skin
 * does the same with CSS variables (`--iui-ink` and friends under `onColor`).
 */
export const OnColorContext = createContext<string | null>(null)

/**
 * The colour a word-part reads in: the raw-colour Box around it when there is one, else the token
 * the part named, else the theme's own ink.
 */
export function useInk(value: string | undefined, skin: Skin): string {
  const on = useContext(OnColorContext)
  return on ?? skin.fg(value) ?? skin.ink
}

/** The skin in force, read from the theme every part is drawn under. */
export const useSkin = () => {
  const { colors } = useTheme()
  return skin(colors, colors['primary'])
}

// Values to styles

/** Spacing in 4px steps, as the web's `space` does. */
export const space = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) * 4 : undefined

/** A px number. A `Length` string such as "50%" has no honest reading on a phone part, so it is left out. */
export const sizeOf = (value: number | string | undefined): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  if (typeof value !== 'string') return undefined
  const px = /^\d+(\.\d+)?px$/.test(value.trim())
  return px ? Number.parseFloat(value) : undefined
}

/**
 * The skin in force, read from the theme. A part calls `useSkin()` and resolves every colour
 * through it, so a display follows the Person's theme and their choice of family, the way the web
 * display follows its CSS variables.
 */
export interface Skin {
  /** The tint the display sits on: 7% of Vivid's colour over the sheet, the web's `--parts-tint`. */
  readonly tint: string
  /** A raised sheet on the tint, what the display holds. */
  readonly sheet: string
  /** A stronger sheet: 12% of Vivid's colour over the sheet, the web's `--iui-surface-strong`. */
  readonly sheetStrong: string
  /** The app's hairline edge, as the theme's own solid border. */
  readonly border: string
  /** A wash of the display's tint, behind a run of code. */
  readonly codeBackground: string
  readonly ink: string
  readonly muted: string
  readonly faint: string
  /** Text on Vivid's own colour (a solid button). */
  readonly onAccent: string
  readonly accent: string
  readonly info: string
  readonly infoSoft: string
  readonly success: string
  readonly successSoft: string
  readonly danger: string
  readonly dangerSoft: string
  /** Text and stroke colours: a token, or a plain colour. */
  fg: (value: string | undefined) => string | undefined
  /** Backgrounds: status tokens become their soft tints, tokens read from the theme. */
  bg: (value: string | undefined) => string | undefined
  /** The phone's radii for the parts' named sizes. */
  radius: (value: z.infer<typeof radiusSchema> | undefined) => number | undefined
  /** The chart's family of colours, `chart1` through `chart6`. */
  chart: (index: number) => string
}

export function skin(colors: Colors, accent: string): Skin {
  // `Colors` carries the same keys on every family; these five exist on all of them.
  const sheet = colors['surface-3']
  const faint = colors['ink-3']
  const family = chartColors(accent, sheet, faint, colors['ink'])
  const token = {
    ink: colors['ink'],
    muted: colors['ink-2'],
    faint: colors['ink-3'],
    canvas: sheet,
    surface: sheet,
    'surface-strong': mix(accent, sheet, 0.12),
    border: colors['line-3'],
    ...Object.fromEntries(STATUS.map((s) => [s, colors[`status-${s}` as keyof Colors] ?? accent])),
    ...Object.fromEntries(STATUS.map((s) => [`${s}-soft`, colors[`status-${s}-soft` as keyof Colors] ?? sheet])),
    ...Object.fromEntries(family.map((c, i) => [`chart${i + 1}`, c])),
  } satisfies Record<string, string>
  return {
    tint: mix(accent, sheet, 0.07),
    sheet,
    sheetStrong: mix(accent, sheet, 0.12),
    border: colors['line-3'],
    codeBackground: mix(accent, sheet, 0.06),
    ink: colors['ink'],
    muted: colors['ink-2'],
    faint: colors['ink-3'],
    onAccent: colors['primary-foreground'],
    accent,
    info: accent,
    infoSoft: mix(accent, sheet, 0.07),
    success: colors['status-success'],
    successSoft: colors['status-success-soft'],
    danger: colors['status-danger'],
    dangerSoft: colors['status-danger-soft'],
    fg: (value) => (typeof value === 'string' && value.trim() && isSafeColor(value) ? (token[value.trim() as keyof typeof token] ?? value.trim()) : undefined),
    bg: (value) => (typeof value === 'string' && value.trim() && isSafeColor(value) ? (token[value.trim() as keyof typeof token] ?? value.trim()) : undefined),
    radius: (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
      // The web's skin rounds a display's own sheet at 14; the parts' named sizes map to the
      // phone's own steps, read from the tokens the app's controls are drawn with.
      const named = { sm: 6, md: 10, lg: 16, xl: 20, full: 999 } as const
      return typeof value === 'string' ? named[value] : undefined
    },
    chart: (index) => family[Math.max(0, index) % family.length],
  }
}
