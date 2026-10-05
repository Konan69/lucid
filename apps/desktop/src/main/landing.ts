import type { SignInReturn } from '@vivid/contracts/signin'
import type { ThemeSurfaces } from './tokens.ts'

/**
 * What the system browser is left showing once Google sign-in has come back to the app: one
 * heading and one line, which say where the Person stands and what to do next. The Person is
 * looking at a browser tab, and the app is behind it, so both pages send them back to Vivid.
 *
 * One entry per way a return can read (`SignInReturn`), so a new kind of return does not
 * typecheck until it has words.
 */
const WORDS: Readonly<
  Record<SignInReturn['_tag'], { readonly heading: string; readonly next: string }>
> = {
  Granted: { heading: 'You are in.', next: 'Go back to Vivid. You can close this tab.' },
  Failed: { heading: 'Google sign-in did not finish.', next: 'Go back to Vivid and try again.' },
}

/**
 * How much of the ink the second line keeps, per scheme. The same two strengths the app's first
 * screen (`apps/web/public/chooser.html`, `--ink-2`) gives its second line. Measured on the
 * shipped tokens, the line is 8.8:1 on the dark page and 7.8:1 on the light one.
 */
const QUIET = { dark: 0.68, light: 0.74 } as const

/**
 * The page, whole: no script, nothing to fetch, and no link to follow.
 *
 * It is served by the listener on the loopback address (`signin.ts`), which stops listening as
 * it answers. So the page cannot ask for a font, an image or a stylesheet: there would be no one
 * to answer. Its type is therefore the app's own stack by name (`--sans` and `--display` in
 * `packages/design/tokens/src/tokens.css`), which draws Geist and Bricolage Grotesque where a
 * computer has them and that system's own face where it does not.
 *
 * The colours are not written here. They are the page and ink the native window is painted with,
 * read from the design tokens at startup (`loadThemeSurfaces`), so the tab matches the app it
 * sends the Person back to. The browser's own scheme chooses between them, because the tab
 * belongs to the browser and not to the app's window. Sizes are the tokens' page title (24px,
 * leading 1.25, `--tracking-display`) and body (15px, leading 1.5).
 *
 * Nothing moves: the page is read once, on the way back to the app.
 */
export const landingPage = (surfaces: ThemeSurfaces, outcome: SignInReturn['_tag']): string => {
  const words = WORDS[outcome]
  const sans =
    "'Geist Variable',-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',system-ui,sans-serif"
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<title>Vivid</title>',
    '<style>',
    `:root{color-scheme:light;--page:${surfaces.light};--ink:${surfaces.inkBase.light};--quiet:${QUIET.light}}`,
    '@media (prefers-color-scheme:dark){',
    `:root{color-scheme:dark;--page:${surfaces.dark};--ink:${surfaces.inkBase.dark};--quiet:${QUIET.dark}}`,
    '}',
    '*{box-sizing:border-box;margin:0}',
    // The two lines sit in the middle of the tab at any size, in one column that starts on one
    // edge. The column is capped so the second line never runs wider than is comfortable to read.
    'body{display:grid;place-items:center;min-height:100dvh;padding:24px;',
    `background:var(--page);color:rgb(var(--ink));font:15px/1.5 ${sans};`,
    '-webkit-font-smoothing:antialiased}',
    'main{width:100%;max-width:360px}',
    `h1{font:600 24px/1.25 'Bricolage Grotesque Variable',${sans};`,
    'letter-spacing:-0.025em;text-wrap:balance}',
    'p{margin-top:8px;color:rgb(var(--ink)/var(--quiet));text-wrap:pretty}',
    '</style>',
    '</head>',
    '<body>',
    `<main><h1>${words.heading}</h1><p>${words.next}</p></main>`,
    '</body>',
    '</html>',
  ].join('\n')
}
