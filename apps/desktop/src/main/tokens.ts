import * as NodeFS from 'node:fs'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { ResolvedColorScheme } from '../shared/bridge.ts'

const HexColor = Schema.String.check(
  Schema.makeFilter((value) =>
    /^#[0-9a-fA-F]{6}$/u.test(value) ? true : 'Expected a six-digit hexadecimal color',
  ),
)
const RgbTriplet = Schema.String.check(
  Schema.makeFilter((value) =>
    /^\d{1,3} \d{1,3} \d{1,3}$/u.test(value) ? true : 'Expected an RGB triplet',
  ),
)

/** Window colors extracted from the shared design-token source for both native schemes. */
export const ThemeSurfaces = Schema.Struct({
  dark: HexColor,
  light: HexColor,
  inkBase: Schema.Struct({
    dark: RgbTriplet,
    light: RgbTriplet,
  }),
})
export interface ThemeSurfaces extends Schema.Schema.Type<typeof ThemeSurfaces> {}

/** The shared token file could not be read from its development or packaged location. */
export class ThemeTokensReadFailed extends Schema.TaggedError<ThemeTokensReadFailed>()(
  'ThemeTokensReadFailed',
  { path: Schema.String },
  { title: 'Desktop theme tokens could not be read' },
) {}

/** Required native-window colors are absent or malformed in the shared token file. */
export class ThemeTokensInvalid extends Schema.TaggedError<ThemeTokensInvalid>()(
  'ThemeTokensInvalid',
  { path: Schema.String },
  { title: 'Desktop theme tokens are invalid' },
) {}

const decodeThemeSurfaces = Schema.decodeUnknownEffect(ThemeSurfaces)

/**
 * Extract only the two native-window colors owned by design tokens. Schema validates capture
 * count and format together, so CSS changes cannot silently substitute a raw fallback color.
 *
 * The page colour is read from `--screen`, the literal the tokens declare; `--surface-0` is
 * `var(--screen)` and so carries no colour of its own. Reading `--surface-0` for a hexadecimal
 * value stopped the app at startup once the tokens were layered that way. The first two
 * declarations are the default dark and light schemes; the named themes after them are the web
 * app's and do not colour the native window.
 */
const parseThemeSurfaces = Effect.fn('DesktopTheme.parseTokens')(function* (
  path: string,
  css: string,
) {
  const surfaces = [...css.matchAll(/--screen:\s*(#[0-9a-fA-F]{6})/gu)].map((match) => match[1])
  const inks = [...css.matchAll(/--ink-base:\s*(\d{1,3} \d{1,3} \d{1,3})/gu)].map(
    (match) => match[1],
  )
  return yield* decodeThemeSurfaces({
    dark: surfaces[0],
    light: surfaces[1],
    inkBase: {
      dark: inks[0],
      light: inks[1],
    },
  }).pipe(Effect.mapError(() => new ThemeTokensInvalid({ path })))
})

/** Read and validate shared design tokens once during desktop startup. */
export const loadThemeSurfaces = Effect.fn('DesktopTheme.loadTokens')(function* (path: string) {
  const css = yield* Effect.try({
    try: () => NodeFS.readFileSync(path, 'utf8'),
    catch: () => new ThemeTokensReadFailed({ path }),
  })
  return yield* parseThemeSurfaces(path, css)
})

/** Native window background for the scheme currently resolved by the operating system. */
export const surfaceFor = (surfaces: ThemeSurfaces, resolved: ResolvedColorScheme): string =>
  resolved === 'dark' ? surfaces.dark : surfaces.light

/** Solid native title-bar glyph color derived from the shared RGB token. */
export const inkFor = (surfaces: ThemeSurfaces, resolved: ResolvedColorScheme): string => {
  const triplet = resolved === 'dark' ? surfaces.inkBase.dark : surfaces.inkBase.light
  return `rgb(${triplet})`
}
