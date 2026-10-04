import type { Shown } from '@vivid/contracts'
import { CHART, chartScale, chartShares as shares, chartValue as said } from '@vivid/state'
import { cn } from '../../ui/cn'

type ChartKind = Extract<Shown, { readonly _tag: 'Chart' }>

/**
 * A chart drawn from what Vivid gave it: bars to compare, a line for change over time, or one bar
 * split into shares of a whole. It is plain SVG sized by its viewBox, so it is sharp at any width
 * and costs nothing while it sits there. Every series has a named colour in the legend and its
 * values in a table for anyone who cannot see the picture.
 *
 * A share is one stacked bar and not a pie: lengths on one line compare more truthfully than
 * angles, and the parts read left to right in the order they were given.
 */
export function Chart({ chart }: { chart: ChartKind }) {
  return (
    <figure>
      {chart.kind === 'share' ? <Share chart={chart} /> : <Plot chart={chart} />}
      {(chart.series.length > 1 || chart.kind === 'share') && <Legend chart={chart} />}
      <Values chart={chart} />
    </figure>
  )
}

/** Up to six series, each with its own colour, in the order they were given. */
const FILL = [
  'fill-primary',
  'fill-face-cyan',
  'fill-face-orange',
  'fill-face-green',
  'fill-face-magenta',
  'fill-face-yellow',
] as const
const STROKE = [
  'stroke-primary',
  'stroke-face-cyan',
  'stroke-face-orange',
  'stroke-face-green',
  'stroke-face-magenta',
  'stroke-face-yellow',
] as const
const SWATCH = [
  'bg-primary',
  'bg-face-cyan',
  'bg-face-orange',
  'bg-face-green',
  'bg-face-magenta',
  'bg-face-yellow',
] as const

const at = <Item,>(list: ReadonlyArray<Item>, index: number): Item => {
  const item = list[index % list.length]
  // The lists above are never empty, so the remainder always lands on an item.
  if (item === undefined) throw new Error('A chart colour list is empty')
  return item
}

const { width: W, height: H, left: LEFT, right: RIGHT } = CHART

/** Bars or lines over shared labels, on a scale that starts at zero unless values go below it. */
function Plot({ chart }: { chart: ChartKind }) {
  const { top, y, slot, every } = chartScale(chart, CHART)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.title} className="w-full">
      <line
        x1={LEFT}
        x2={W - RIGHT}
        y1={y(0)}
        y2={y(0)}
        className="stroke-line-3"
        strokeWidth={1}
      />
      <line
        x1={LEFT}
        x2={W - RIGHT}
        y1={y(top)}
        y2={y(top)}
        className="stroke-line-2"
        strokeWidth={1}
        strokeDasharray="3 4"
      />
      <text x={LEFT} y={y(top) - 3} className="fill-ink-3 text-meta tabular-nums">
        {said(top, chart.unit)}
      </text>
      {/* Under the baseline, clear of the bars: the other end of the scale, so a height reads against two numbers. */}
      <text x={LEFT} y={y(0) + 11} className="fill-ink-3 text-meta tabular-nums">
        {said(0, chart.unit)}
      </text>
      {chart.kind === 'bar' ? (
        <Bars chart={chart} slot={slot} y={y} />
      ) : (
        <Lines chart={chart} slot={slot} y={y} />
      )}
      {chart.labels.map((label, index) =>
        index % every === 0 ? (
          <text
            key={label}
            x={LEFT + slot * index + slot / 2}
            y={H - 8}
            textAnchor="middle"
            className="fill-ink-3 text-meta"
          >
            {label.length > 12 ? `${label.slice(0, 11)}…` : label}
          </text>
        ) : null,
      )}
    </svg>
  )
}

function Bars({
  chart,
  slot,
  y,
}: {
  chart: ChartKind
  slot: number
  y: (value: number) => number
}) {
  const group = slot * 0.72
  const bar = group / chart.series.length
  return chart.series.map((series, order) =>
    series.values.map((value, index) => (
      <rect
        // A bar has no identity but its series and its place.
        // oxlint-disable-next-line react/no-array-index-key
        key={`${series.name}:${index}`}
        x={LEFT + slot * index + (slot - group) / 2 + bar * order}
        y={Math.min(y(value), y(0))}
        width={Math.max(bar - 2, 1)}
        height={Math.max(Math.abs(y(value) - y(0)), 1)}
        rx={3}
        className={at(FILL, order)}
      >
        <title>{`${series.name}, ${chart.labels[index]}: ${said(value, chart.unit)}`}</title>
      </rect>
    )),
  )
}

function Lines({
  chart,
  slot,
  y,
}: {
  chart: ChartKind
  slot: number
  y: (value: number) => number
}) {
  const x = (index: number) => LEFT + slot * index + slot / 2
  // One line alone also gets the area under it, in the same colour at a whisper; with several, the
  // fills would stack into mud, so they stay lines.
  const area = chart.series.length === 1
  return chart.series.map((series, order) => (
    <g key={series.name}>
      {area && (
        <polygon
          points={`${x(0)},${y(0)} ${series.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')} ${x(series.values.length - 1)},${y(0)}`}
          className="fill-primary/10"
        />
      )}
      <polyline
        points={series.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
        fill="none"
        strokeWidth={2.25}
        strokeLinejoin="round"
        strokeLinecap="round"
        className={at(STROKE, order)}
      />
      {series.values.length <= 24 &&
        series.values.map((value, index) => (
          // A point has no identity but its series and its place.
          // oxlint-disable-next-line react/no-array-index-key
          <circle key={index} cx={x(index)} cy={y(value)} r={3} className={at(FILL, order)}>
            <title>{`${series.name}, ${chart.labels[index]}: ${said(value, chart.unit)}`}</title>
          </circle>
        ))}
    </g>
  ))
}

/** The first series as parts of one whole: one bar, split by each part's share of the total. */
function Share({ chart }: { chart: ChartKind }) {
  const parts = shares(chart)
  return (
    <svg viewBox={`0 0 ${W} 28`} role="img" aria-label={chart.title} className="w-full">
      {parts.map((part, index) => {
        const x = part.from * W
        return (
          <rect
            key={part.label}
            x={x}
            y={0}
            width={Math.max(part.share * W - 2, 1)}
            height={28}
            rx={6}
            className={at(FILL, index)}
          >
            <title>{`${part.label}: ${said(part.value, chart.unit)}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

/** Which colour is which: the series of a plot, or the parts of a share with their percentages. */
function Legend({ chart }: { chart: ChartKind }) {
  const names =
    chart.kind === 'share'
      ? shares(chart).map((part) => `${part.label} · ${Math.round(part.share * 100)}%`)
      : chart.series.map((series) => series.name)
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {names.map((name, index) => (
        <li key={name} className="flex items-center gap-1.5 text-meta text-ink-2 tabular-nums">
          <i aria-hidden className={cn('size-2 rounded-full', at(SWATCH, index))} />
          {name}
        </li>
      ))}
    </ul>
  )
}

/** The same numbers as a table, for a screen reader: a picture alone says nothing to one. */
function Values({ chart }: { chart: ChartKind }) {
  return (
    <table className="sr-only">
      <caption>{chart.title}</caption>
      <thead>
        <tr>
          <th scope="col">Label</th>
          {chart.series.map((series) => (
            <th key={series.name} scope="col">
              {series.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {chart.labels.map((label, index) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            {chart.series.map((series) => {
              const value = series.values[index]
              return <td key={series.name}>{value === undefined ? '' : said(value, chart.unit)}</td>
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
