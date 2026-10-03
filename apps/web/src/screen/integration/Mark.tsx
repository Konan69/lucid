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

/** A service's name as its logo file is named: "Google Calendar" is "google-calendar". */
const fileOf = (name: string) =>
  name
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '')

/**
 * The logo for a service, when there is one. The catalog sends no artwork for any service yet
 * (`Service.mark` is always null), so a service is recognised by its whole name and by nothing
 * less: "Zoom for Claude" is not Zoom, and gets no logo it has not earned.
 */
const logoOf = (name: string) => Option.fromUndefinedOr(LOGOS[`./logos/${fileOf(name)}.svg`])

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
 * A service's logo on a white rounded square, the way an app icon sits on a home screen and the
 * way the reference's tiles show one (`refs/grok-bot-screenshots/02-what-do-you-use-every-day.png`).
 * The square is white in both themes, because the logos are drawn for a white ground. A service
 * with no logo here gets its initial in white on a square of one of the face colours: true to its
 * name, never a made-up mark, and still a shape of colour beside the real logos in a grid.
 */
export function Mark({
  service,
  size = 32,
  className,
}: {
  service: { readonly name: string }
  size?: number
  className?: string
}) {
  const logo = logoOf(service.name)
  // SAFETY: React forwards this validated CSS custom property to the element.
  const tileStyle = { '--mark-size': `${size}px` } as React.CSSProperties
  return (
    <span
      aria-hidden
      style={tileStyle}
      className={cn(
        'inline-flex size-(--mark-size) shrink-0 items-center justify-center overflow-hidden rounded-control text-title font-title',
        // A logo's white square needs the edge to be seen on a light page; a square of colour
        // is its own edge.
        Option.isSome(logo) ? 'bg-white edge' : cn('text-ink-on-color', hueOf(service.name)),
        className,
      )}
    >
      {Option.isSome(logo) ? (
        // The logo is drawn at 5/8 of the square, which leaves it the breathing room of an icon.
        <img src={logo.value} alt="" className="size-5/8 object-contain" />
      ) : (
        service.name.trim().slice(0, 1).toLocaleUpperCase()
      )}
    </span>
  )
}
