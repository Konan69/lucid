import { tagSchemaId } from '@openuidev/react-lang'
import { createContext, useContext } from 'react'
import { z } from 'zod/v4'
import { useTheme } from '../theme'

/**
 * The parts' shared prop schemas and the skin over them, for the phone. Every schema here is
 * copied exactly from the web's vendored sources (`apps/web/vendor/openui/style.ts`): the schema
 * is the model-facing vocabulary, and a difference between surfaces would make a display the
 * model wrote for one decode differently on the other. `library.test.ts` holds the phone's spec
 * against the runtime's `parts.json`, which the web's library was generated from, so drift fails
 * a test rather than a Person's display.
 *
 * The value helpers (`fg`, `bgOf`, `radiusOf`, `space`, `sizeOf`) read OpenUI's own theme
 * (`OPENUI` below, the phone's copy of the web's `vendor/openui/theme.css`), so a display looks
 * as OpenUI draws it on both surfaces.
 */

// Safety
// A model-written style value could otherwise name a resource. CSS has no meaning on the phone,
// so nothing model-written is ever read as CSS here; only plain colours pass through, checked the
// same way the web checks them before it lets them into a style.
const UNSAFE_CSS =
  /(url|image|image-set|cross-fade|element|expression|paint|var|attr|env)\s*\(|@import|[\\;{}<>]/i
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
export const useSkin = () => skin(useTheme().dark)

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
  /** The edge of something to press or fill in, the web's `--iui-border-strong`. */
  readonly borderStrong: string
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

/**
 * OpenUI's own theme, the phone's copy of the `--iui-*` variables in the web's
 * `vendor/openui/theme.css` (light, then dark). A display looks as OpenUI draws it on both
 * surfaces; changing the look is changing these values, never restyling a part.
 */
const OPENUI = {
  light: {
    canvas: '#ffffff',
    surface: '#f7f7f8',
    surfaceStrong: '#ececec',
    ink: '#0d0d0d',
    onInk: '#ffffff',
    muted: '#676767',
    faint: '#8f8f8f',
    border: '#e7e7e7',
    borderStrong: '#cecece',
    info: '#0068bc',
    infoSoft: '#edf5ff',
    success: '#00805d',
    successSoft: '#edf9f2',
    warning: '#946200',
    warningSoft: '#fff8e7',
    danger: '#c1322c',
    dangerSoft: '#fff0ee',
    purple: '#7040c1',
    purpleSoft: '#f4f0ff',
    pink: '#b7377c',
    pinkSoft: '#fff0f6',
    chart: ['#0285ff', '#00a67d', '#8b5cf6', '#f4a340', '#e46d91', '#4b9ca6'],
  },
  dark: {
    canvas: '#212121',
    surface: '#2a2a2a',
    surfaceStrong: '#3a3a3a',
    ink: '#ececec',
    onInk: '#171717',
    muted: '#ababab',
    faint: '#8c8c8c',
    border: '#383838',
    borderStrong: '#4d4d4d',
    info: '#7cb8ff',
    infoSoft: '#16273b',
    success: '#5bcf9c',
    successSoft: '#13291f',
    warning: '#f0b84f',
    warningSoft: '#30250f',
    danger: '#ff7d74',
    dangerSoft: '#3a1b19',
    purple: '#b49cff',
    purpleSoft: '#261f3a',
    pink: '#f28cc0',
    pinkSoft: '#371b2a',
    chart: ['#3d9dff', '#22bf91', '#a07cff', '#f6ae55', '#ec84a3', '#5fb3bd'],
  },
} as const

export function skin(dark: boolean): Skin {
  const theme = dark ? OPENUI.dark : OPENUI.light
  const family = theme.chart
  const token = {
    ink: theme.ink,
    muted: theme.muted,
    faint: theme.faint,
    canvas: theme.canvas,
    surface: theme.surface,
    'surface-strong': theme.surfaceStrong,
    border: theme.border,
    info: theme.info,
    success: theme.success,
    warning: theme.warning,
    danger: theme.danger,
    purple: theme.purple,
    pink: theme.pink,
    'info-soft': theme.infoSoft,
    'success-soft': theme.successSoft,
    'warning-soft': theme.warningSoft,
    'danger-soft': theme.dangerSoft,
    'purple-soft': theme.purpleSoft,
    'pink-soft': theme.pinkSoft,
    ...Object.fromEntries(family.map((c, i) => [`chart${i + 1}`, c])),
  } satisfies Record<string, string>
  return {
    tint: theme.canvas,
    sheet: theme.canvas,
    sheetStrong: theme.surfaceStrong,
    border: theme.border,
    borderStrong: theme.borderStrong,
    codeBackground: theme.surface,
    ink: theme.ink,
    muted: theme.muted,
    faint: theme.faint,
    // OpenUI's solid button and selection ring are its ink.
    onAccent: theme.onInk,
    accent: theme.ink,
    info: theme.info,
    infoSoft: theme.infoSoft,
    success: theme.success,
    successSoft: theme.successSoft,
    danger: theme.danger,
    dangerSoft: theme.dangerSoft,
    fg: (value) =>
      typeof value === 'string' && value.trim() && isSafeColor(value)
        ? (token[value.trim() as keyof typeof token] ?? value.trim())
        : undefined,
    bg: (value) =>
      typeof value === 'string' && value.trim() && isSafeColor(value)
        ? (token[value.trim() as keyof typeof token] ?? value.trim())
        : undefined,
    radius: (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
      // OpenUI's own radii (`--iui-radius-sm` to `--iui-radius-xl`).
      const named = { sm: 6, md: 10, lg: 12, xl: 16, full: 999 } as const
      return typeof value === 'string' ? named[value] : undefined
    },
    chart: (index) => family[Math.max(0, index) % family.length],
  }
}
