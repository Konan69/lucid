import { Option } from 'effect'
import { cn } from '../../ui/cn'

/**
 * The services' own logos, one file each under `logos/`, named by the service's name in
 * lower-case with hyphens ("google-calendar.svg"). Vite turns each into an address at build
 * time, so a logo costs nothing until it is drawn and adding one is adding a file.
 */
const LOGOS: Record<string, string> = import.meta.glob('./logos/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
})

/**
 * App icons, under `icons/`: artwork that is already a whole square with its own ground (the
 * green Messages tile). They fill the tile to its corners; a logo from `logos/` is a mark with
 * no ground and is drawn smaller, with room around it.
 */
const ICONS: Record<string, string> = import.meta.glob('./icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
})

/** A service's name as its logo file is named: "Google Calendar" is "google-calendar". */
const fileOf = (name: string) =>
  name
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '')

/** The one size asked of the icon service; see `artOf`. */
const ICON_SIZE = 128

/** How a service is drawn: a whole icon, a mark on a ground, or its initial on a colour. */
type Art =
  | { readonly kind: 'icon'; readonly address: string }
  | { readonly kind: 'logo'; readonly address: string }
  | { readonly kind: 'initial' }

/**
 * The artwork for a service. The bundled files win, found by the service's whole name and by
 * nothing less ("Zoom for Claude" is not Zoom): they are the brands' own vector marks, sharp at
 * any size. A service with no bundled file takes the icon of its site, at the address the server
 * sends, which is the only artwork an added server or a less-known catalog service has. A
 * service with neither is drawn as its initial.
 */
const artOf = (service: { readonly name: string; readonly mark?: string | null }): Art => {
  const file = fileOf(service.name)
  const icon = Option.fromUndefinedOr(ICONS[`./icons/${file}.svg`])
  if (Option.isSome(icon)) return { kind: 'icon', address: icon.value }
  const logo = Option.fromUndefinedOr(LOGOS[`./logos/${file}.svg`])
  if (Option.isSome(logo)) return { kind: 'logo', address: logo.value }
  const sent = Option.fromNullishOr(service.mark)
  // The icon service answers only at its own sizes and falls to the 16-pixel favicon for any
  // other (asking for 88 returned 15x16 on production). 128 is the size it has that covers every
  // tile here at twice its drawn size.
  if (Option.isSome(sent)) return { kind: 'icon', address: `${sent.value}&sz=${ICON_SIZE}` }
  return { kind: 'initial' }
}

/** The fills a service without a logo may take: the saturated face colours, the grey left out. */
const HUES = [
  'bg-face-blue',
  'bg-face-violet',
  'bg-face-magenta',
  'bg-face-red',
  'bg-face-orange',
  'bg-face-green',
  'bg-face-cyan',
  'bg-face-yellow',
] as const

/**
 * The colour a service without a logo always gets. It is taken from the letters of its name, so
 * the same service is the same colour on every screen and every visit, and it means nothing
 * more than "this one": no hue is reserved for a kind of service.
 */
const hueOf = (name: string) => {
  const sum = Array.from(name.trim().toLocaleLowerCase()).reduce(
    (total, letter) => total + (letter.codePointAt(0) ?? 0),
    0,
  )
  return HUES[sum % HUES.length]
}

/**
 * A service's artwork in a rounded square, the way an app icon sits on a home screen.
 *
 * Nothing is drawn around it. An earlier version put every logo on a white square with a ring,
 * which read as a border around a border on a card that already has an edge. Now an icon fills
 * the square to its corners; a mark with no ground of its own sits on white only where the page
 * is dark (the marks are drawn for a light ground), and on nothing where the page is light; a
 * service with no artwork gets its initial in white on one of the face colours.
 */
export function Mark({
  service,
  size = 32,
  className,
}: {
  /**
   * `mark` is the address of the service's icon when the server knows one (the icon of the site
   * the Integration came from, without a size). A caller that only has a name passes no mark and
   * gets the bundled artwork for that exact name.
   */
  service: { readonly name: string; readonly mark?: string | null }
  size?: number
  className?: string
}) {
  const art = artOf(service)
  // SAFETY: React forwards this validated CSS custom property to the element.
  const tileStyle = { '--mark-size': `${size}px` } as React.CSSProperties
  return (
    <span
      aria-hidden
      style={tileStyle}
      className={cn(
        'inline-flex size-(--mark-size) shrink-0 items-center justify-center overflow-hidden rounded-control text-title font-title',
        art.kind === 'logo' && 'dark:bg-white',
        art.kind === 'initial' && cn('text-ink-on-color', hueOf(service.name)),
        className,
      )}
    >
      {art.kind === 'icon' && <img src={art.address} alt="" className="size-full object-cover" />}
      {art.kind === 'logo' && (
        // A mark is drawn at 3/4 of the square, which leaves it the breathing room of an icon.
        <img src={art.address} alt="" className="size-3/4 object-contain" />
      )}
      {art.kind === 'initial' && service.name.trim().slice(0, 1).toLocaleUpperCase()}
    </span>
  )
}
