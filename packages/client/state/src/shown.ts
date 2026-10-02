import { ShowRequest, type Shown } from '@vivid/contracts'
import { Schema } from 'effect'

/** Tool input is untrusted; incomplete or malformed displays draw nothing on either surface. */
export const readShown = Schema.decodeUnknownOption(ShowRequest)

/** A show call's display is its record, so it never also appears in the list of steps. */
export const drawn = (tool: { readonly toolName: string }): boolean => tool.toolName === 'show'

/** The chart contract supplies shared labels and at most six named series. */
export type ShownChart = Extract<Shown, { readonly _tag: 'Chart' }>

/** Both SVG surfaces use these drawing units, independent of the device's pixel density. */
export const CHART = { width: 640, height: 240, left: 8, right: 8, top: 12, bottom: 28 } as const

/** Zero stays in the scale, including negative values and charts whose values are all zero. */
export function chartScale(chart: ShownChart) {
  const all = chart.series.flatMap((series) => series.values)
  const top = Math.max(0, ...all)
  const floor = Math.min(0, ...all)
  const span = top - floor === 0 ? 1 : top - floor
  return {
    top,
    y: (value: number) =>
      CHART.top + ((top - value) / span) * (CHART.height - CHART.top - CHART.bottom),
    slot: (CHART.width - CHART.left - CHART.right) / chart.labels.length,
    every: Math.ceil(chart.labels.length / 8),
  }
}

/** Each part uses the first series; negative and missing parts count as none, as on the web. */
export function chartShares(chart: ShownChart) {
  const first = chart.series[0]
  const values = first === undefined ? [] : first.values.map((value) => Math.max(value, 0))
  const total = values.reduce((sum, value) => sum + value, 0)
  let from = 0
  return chart.labels.map((label, index) => {
    const value = values[index]
    const amount = value === undefined ? 0 : value
    const share = total === 0 ? 0 : amount / total
    const start = from
    from += share
    return { label, value: amount, share, from: start }
  })
}

const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/** Values read with grouped digits and the exact unit Vivid supplied. */
export const chartValue = (value: number, unit: ShownChart['unit']): string =>
  `${numbers.format(value)}${unit === undefined ? '' : unit}`

/** A web address as people say it: the site, without the scheme or a leading "www". */
export const siteOf = (address: string): string =>
  URL.canParse(address) ? new URL(address).hostname.replace(/^www\./u, '') : address

/** Sending a draft says these words in the Thread; it never sends to its recipients directly. */
export const DRAFT_WORDS = {
  email: { name: 'Email draft', send: 'Send it' },
  message: { name: 'Message draft', send: 'Send it' },
  post: { name: 'Post draft', send: 'Post it' },
  document: { name: 'Draft', send: 'Use it' },
} as const satisfies Record<
  Extract<Shown, { readonly _tag: 'Draft' }>['kind'],
  { name: string; send: string }
>

/** Empty fields say nothing; filled fields become readable lines in their original order. */
export const formReply = (
  entries: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): string =>
  entries
    .flatMap(({ label, value }) => (value.trim().length === 0 ? [] : [`${label}: ${value.trim()}`]))
    .join('\n')
