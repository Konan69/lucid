import { defineComponent } from '@openuidev/react-lang'
import { Option } from 'effect'
import { useState } from 'react'
import { z } from 'zod/v4'

/** An absolute http or https address, the only kind a card opens; anything else is not a link. */
const pageAddress = (value: string): Option.Option<URL> =>
  Option.filter(
    Option.liftThrowable((text: string) => new URL(text.trim()))(value),
    (url) => url.protocol === 'http:' || url.protocol === 'https:',
  )

/** The site a page is on, as its address says it, when the display did not name it. */
const siteOf = (url: URL) => url.hostname.replace(/^www\./u, '')

/**
 * A web page as a card: its picture, the site, its title and a few lines of what it says, the
 * way a link unfurls in a message. The whole card opens the page in a new tab. A picture that
 * does not load leaves the card without one rather than an empty frame, because the words are the
 * card and the picture only dresses it. An address that is not a web page draws the same card,
 * not pressable.
 */
export const Page = defineComponent({
  name: 'Page',
  props: z.object({
    url: z.string(),
    title: z.string(),
    site: z.string().optional(),
    image: z.string().optional(),
    summary: z.string().optional(),
  }),
  description:
    'A web page as a card that opens it: its title, the site, its picture and a short summary. Only an address and picture a tool or the Person gave you.',
  component: function Unfurled({ props }) {
    const [broken, setBroken] = useState(false)
    const address = pageAddress(props.url)
    const picture = Option.flatMap(Option.fromUndefinedOr(props.image), pageAddress)
    const site = Option.getOrElse(
      Option.orElse(
        Option.filter(Option.fromUndefinedOr(props.site), (named) => named.trim() !== ''),
        () => Option.map(address, siteOf),
      ),
      () => '',
    )
    const inner = (
      <>
        {Option.isSome(picture) && !broken && (
          <span className="vivid-page-image">
            <img
              src={picture.value.href}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setBroken(true)}
            />
          </span>
        )}
        <span className="vivid-page-body">
          {site !== '' && <span className="vivid-page-site">{site}</span>}
          <span className="vivid-page-title">{props.title}</span>
          {props.summary !== undefined && props.summary.trim() !== '' && (
            <span className="vivid-page-summary">{props.summary}</span>
          )}
        </span>
      </>
    )
    return Option.match(address, {
      onNone: () => <div className="vivid-page">{inner}</div>,
      onSome: (url) => (
        <a className="vivid-page is-link" href={url.href} target="_blank" rel="noopener noreferrer">
          {inner}
        </a>
      ),
    })
  },
})
