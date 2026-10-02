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

/** SVG drawing units are explicit so phone plots can use readable type without changing data. */
export interface ChartDrawing {
  readonly width: number
  readonly height: number
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** Zero stays in the scale, including negative values and charts whose values are all zero. */
export function chartScale(chart: ShownChart, drawing: ChartDrawing) {
  const all = chart.series.flatMap((series) => series.values)
  const top = Math.max(0, ...all)
  const floor = Math.min(0, ...all)
  const span = top - floor === 0 ? 1 : top - floor
  return {
    top,
    y: (value: number) =>
      drawing.top + ((top - value) / span) * (drawing.height - drawing.top - drawing.bottom),
    slot: (drawing.width - drawing.left - drawing.right) / chart.labels.length,
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

/** Selection order is the order said in the Thread; removing a choice preserves the others. */
export const togglePicked = (
  picked: ReadonlyArray<string>,
  label: string,
): ReadonlyArray<string> =>
  picked.includes(label) ? picked.filter((one) => one !== label) : [...picked, label]

/** Native paging puts Vivid's recommendation first without changing any item or the other order. */
export function comparisonOrder(comparison: Extract<Shown, { readonly _tag: 'Comparison' }>) {
  if (comparison.pick === undefined) return comparison.items
  const { name } = comparison.pick
  return comparison.items.toSorted(
    (left, right) => Number(right.name === name) - Number(left.name === name),
  )
}

/** Short drafts stay fully visible; long prose or many paragraphs get a separate reading view. */
export const draftIsLong = (body: string): boolean =>
  body.length > 320 || body.split('\n').length > 6

/**
 * A table row's cells, one per column. The contract only bounds a row's length, so a short row
 * leaves its later cells empty (as the web's table does) instead of drawing "undefined".
 */
export const rowCells = (row: ReadonlyArray<string>, count: number): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, index) => row.slice(index, index + 1).join(''))
