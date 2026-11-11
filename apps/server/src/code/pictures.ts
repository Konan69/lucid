import { PagePicture } from '@vivid/contracts'
import { Option } from 'effect'

/** A display shows a few pictures at most; more would only cost the model's context. */
const LIMIT = 8

/** Names of a page's own lead picture, as Open Graph and Twitter cards declare it. */
const LEAD = new Set(['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image'])

/**
 * Words in an address that mark a picture that is chrome, not content: a logo, an icon, a sprite,
 * a tracking pixel. Such pictures are small and say nothing about the page.
 */
const CHROME =
  /(?:^|[/_.-])(?:logo|icon|favicon|sprite|pixel|spacer|badge|button|emoji)s?(?:[/_.-]|$)/iu

/** Attributes of one tag, lower-cased by name, with the HTML entities a URL holds decoded. */
function attributesOf(tag: string) {
  const attributes = new Map<string, string>()
  for (const [, name = '', double, single, bare] of tag.matchAll(
    /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gu,
  ))
    attributes.set(
      name.toLowerCase(),
      (double ?? single ?? bare ?? '')
        .replaceAll('&amp;', '&')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .trim(),
    )
  return attributes
}

/** An absolute http or https address for a picture written on the page, if it is one. */
function addressOf(written: string, base: URL) {
  if (written.length === 0 || written.startsWith('data:')) return Option.none<string>()
  const url = URL.parse(written, base.href)
  return url !== null && (url.protocol === 'https:' || url.protocol === 'http:')
    ? Option.some(url.href)
    : Option.none<string>()
}

/** A body picture the page sizes below this many pixels on either side is an icon, not content. */
const smallest = 120

/** Whether an `<img>` says it is small: a written width or height under `smallest`. */
function small(attributes: Map<string, string>) {
  return ['width', 'height'].some((side) => {
    const size = Number.parseInt(attributes.get(side) ?? '', 10)
    return Number.isFinite(size) && size < smallest
  })
}

/** The page's declared lead picture, Open Graph or Twitter, with its declared alt if any. */
function leadOf(tags: ReadonlyArray<Map<string, string>>, base: URL, title: string) {
  const named = (key: string) =>
    Option.flatMap(
      Option.fromUndefinedOr(
        tags.find(
          (attributes) =>
            (attributes.get('property') ?? attributes.get('name') ?? '').toLowerCase() === key,
        ),
      ),
      (attributes) => Option.fromUndefinedOr(attributes.get('content')),
    )
  const alt = Option.getOrElse(named('og:image:alt'), () => title)
  return [...LEAD].flatMap((key) =>
    Option.toArray(Option.flatMap(named(key), (content) => addressOf(content, base))).map(
      (address) => PagePicture.make({ address, alt }),
    ),
  )
}

/** A body picture that shows content: not inline data, an icon, chrome or an SVG drawing. */
function bodyOf(attributes: Map<string, string>, base: URL) {
  const address = addressOf(attributes.get('src') ?? attributes.get('data-src') ?? '', base)
  if (Option.isNone(address) || small(attributes)) return []
  if (CHROME.test(address.value) || /\.svg(?:[?#]|$)/iu.test(address.value)) return []
  return [PagePicture.make({ address: address.value, alt: attributes.get('alt') ?? '' })]
}

/**
 * The pictures a page shows, for a display to draw: its declared lead picture first (Open Graph,
 * then Twitter), then its body pictures in order, without chrome, small images, SVG or repeats.
 * Read from the raw HTML because the readable text drops every image; a tag scan is enough for
 * `<meta>` and `<img>`, which hold their address in one attribute. The lead picture's alt comes
 * from `og:image:alt`, else the page's title.
 */
export function picturesOf(html: string, base: URL, title: string) {
  const tags = [...html.matchAll(/<(meta|img)\b[^>]*>/giu)].map(([tag, name = '']) => ({
    meta: name.toLowerCase() === 'meta',
    attributes: attributesOf(tag),
  }))
  const lead = leadOf(
    tags.flatMap(({ meta, attributes }) => (meta ? [attributes] : [])),
    base,
    title,
  )
  const body = tags
    .filter(({ meta }) => !meta)
    .flatMap(({ attributes }) => bodyOf(attributes, base))
  const seen = new Set<string>()
  return [...lead, ...body]
    .filter((picture) => !seen.has(picture.address) && seen.add(picture.address))
    .slice(0, LIMIT)
}
