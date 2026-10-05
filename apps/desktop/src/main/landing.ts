import type { SignInReturn } from '@vivid/contracts/signin'
import type { ThemeSurfaces } from './tokens.ts'

/**
 * What the system browser is left showing once Google sign-in has come back to the app: Vivid's
 * face, then one heading and one line, which say where the Person stands and what to do next.
 * The Person is looking at a browser tab, and the app is behind it, so both pages send them
 * back to Vivid.
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
 * How far the face leans, in degrees, for each way a return can read. They are two of the moods of
 * `FACE_TILT_DEGREES` (`packages/design/marks/src/face.ts`): `happy` when the Person is in, which
 * is the face the welcome screen shows, and `neutral` when sign-in did not finish.
 */
const LEAN: Readonly<Record<SignInReturn['_tag'], number>> = { Granted: 4, Failed: 0 }

/**
 * Vivid's face, 56px, as the welcome screen draws it (`apps/web/src/ui/Face.tsx` with the `face`
 * utilities of `apps/web/src/styles/index.css`): the disc nobody has changed, in the accent.
 *
 * It is drawn the way the web face is. The disc is the element's own painted box, a filled circle
 * with the highlight over it and the two shadows around it, and `faceRule` below repeats the
 * `face` utility's values for it. The eyes are the two shapes inside. The disc is not an SVG
 * circle because the highlight is a gradient, and SVG can only paint with one by reference
 * (`fill="url(#…)"`); this page refers to nothing, itself included, so the gradient stays in CSS
 * where the web app has it.
 *
 * The eyes are `faceGeometry(56, mood, 'circle')` worked out: 6 wide (`round(56 × 0.11)`), 13 tall
 * (`round(56 × 0.24)`), 12 apart (`round(56 × 0.22)`), their tops 38% down (21.28). The pair is
 * centred, so they start at x 16 and 34, and each is a full pill (`rx` 3) turned 6° outwards about
 * its own middle, as `-rotate-6` and `rotate-6` do. The numbers are written out because this
 * package does not depend on `@vivid/marks`; a change to the face there has to be made here too.
 *
 * It is static: the web face blinks and eases its lean in a Thread, and this one is read once.
 * It says nothing to a screen reader, because the heading under it already says where the Person
 * stands.
 */
const FACE = [
  '<svg class="face" aria-hidden="true" viewBox="0 0 56 56" width="56" height="56">',
  '<rect x="16" y="21.28" width="6" height="13" rx="3" transform="rotate(-6 19 27.78)"/>',
  '<rect x="34" y="21.28" width="6" height="13" rx="3" transform="rotate(6 37 27.78)"/>',
  '</svg>',
].join('')

/**
 * The face's box, for one lean. The highlight and the two shadows are the `face` utility's own
 * values, white and black at the same strengths in both schemes; they are light and shade on the
 * face and not colours of the theme, so the tokens have no name for them. The fill and the eyes
 * are the tokens' (`--face`, `--eye`). Under forced colours a browser drops backgrounds, which
 * would leave two eyes and no face, so the face keeps its own colours there.
 */
const faceRule = (lean: number): string =>
  [
    '.face{display:block;border-radius:50%;',
    `transform:rotate(${lean}deg);`,
    'background:var(--face) radial-gradient(circle at 32% 28%,rgb(255 255 255/0.28),transparent 55%);',
    'box-shadow:inset 0 -1px 2px rgb(0 0 0/0.25),0 1px 2px rgb(0 0 0/0.18);',
    'fill:var(--eye);forced-color-adjust:none}',
  ].join('')

/**
 * The page, whole: no script, nothing to fetch, and no link to follow.
 *
 * It is served by the listener on the loopback address (`signin.ts`), which stops listening as
 * it answers. So the page cannot ask for a font, an image or a stylesheet: there would be no one
 * to answer. Its type is therefore the app's own stack by name (`--sans` and `--display` in
 * `packages/design/tokens/src/tokens.css`), which draws Geist and Bricolage Grotesque where a
 * computer has them and that system's own face where it does not.
 *
 * The colours are not written here. They are the page and ink the native window is painted with
 * and the accent and eye colour Vivid's face is drawn in, read from the design tokens at startup
 * (`loadThemeSurfaces`), so the tab matches the app it sends the Person back to. The browser's
 * own scheme chooses between them, because the tab belongs to the browser and not to the app's
 * window. Sizes are the tokens' page title (24px, leading 1.25, `--tracking-display`) and body
 * (15px, leading 1.5).
 *
 * The face is what says whose page this is: without it the tab was two lines of text on an empty
 * page, with nothing of Vivid in it. It sits on the same left edge as the words, 20px above the
 * heading, which is further than the 8px between the heading and its line so the two lines still
 * read as one thing.
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
    // The eye colour is one for both schemes, so it is set once and the dark block leaves it.
    `:root{color-scheme:light;--page:${surfaces.light};--ink:${surfaces.inkBase.light};--quiet:${QUIET.light};--face:${surfaces.face.light};--eye:${surfaces.face.eye}}`,
    '@media (prefers-color-scheme:dark){',
    `:root{color-scheme:dark;--page:${surfaces.dark};--ink:${surfaces.inkBase.dark};--quiet:${QUIET.dark};--face:${surfaces.face.dark}}`,
    '}',
    '*{box-sizing:border-box;margin:0}',
    // The face and the two lines sit in the middle of the tab at any size, in one column that
    // starts on one edge. The column is capped so the second line never runs wider than is
    // comfortable to read.
    'body{display:grid;place-items:center;min-height:100dvh;padding:24px;',
    `background:var(--page);color:rgb(var(--ink));font:15px/1.5 ${sans};`,
    '-webkit-font-smoothing:antialiased}',
    'main{width:100%;max-width:360px}',
    `h1{font:600 24px/1.25 'Bricolage Grotesque Variable',${sans};`,
    'margin-top:20px;letter-spacing:-0.025em;text-wrap:balance}',
    faceRule(LEAN[outcome]),
    'p{margin-top:8px;color:rgb(var(--ink)/var(--quiet));text-wrap:pretty}',
    '</style>',
    '</head>',
    '<body>',
    `<main>${FACE}<h1>${words.heading}</h1><p>${words.next}</p></main>`,
    '</body>',
    '</html>',
  ].join('\n')
}
