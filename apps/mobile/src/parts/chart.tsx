import { defineComponent } from '@openuidev/react-lang'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg'
import { z } from 'zod/v4'
import { useSkin } from './style'

/**
 * The chart part (`apps/web/vendor/openui/chart.tsx`), drawn with `react-native-svg`: the same
 * spec, the same axis arithmetic and the same number formatting, and the same reading — a chart
 * is one colour in six strengths, the bar it is about at full strength and the axis gone.
 *
 * The web's reading is a hover; the phone's is a press. A touch on the plot names the nearest
 * column — the guide line and its figures — until the finger lifts, and the pressed column reads
 * like the web's hover band. The pressed answer is drawn from the row's own data, in its own
 * words, never a rounded stub.
 */
type Row = Record<string, unknown>
type Format = (value: number, compact?: boolean) => string
type Spec = {
  type: 'bar' | 'line' | 'area' | 'pie' | 'donut' | 'scatter'
  rows: Row[]
  x: string
  series: string[]
  stacked: boolean
  height: number
  format: Format
  /** The category a bar chart is about. Its bar carries its value; the others recede and the axis goes. */
  highlight: string | null
}

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0
const label = (row: Row, x: string) =>
  typeof row[x] === 'string'
    ? row[x]
    : typeof row[x] === 'number' && Number.isFinite(row[x])
      ? String(row[x])
      : ''

function makeFormat(kind: string | undefined, currency: string | undefined): Format {
  const code =
    typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : 'USD'
  // Axis ticks are compact ("$2B"); a pressed column keeps two decimals ("$1.24B").
  return (value, compact) => {
    if (kind === 'percent') return `${Number(value.toFixed(compact ? 1 : 2))}%`
    const big = Math.abs(value) >= (compact ? 1000 : 1e6)
    const options: Intl.NumberFormatOptions = {
      minimumFractionDigits: 0,
      maximumFractionDigits: compact && big ? 1 : 2,
      ...(big ? { notation: 'compact' } : {}),
    }
    return value.toLocaleString(
      'en-US',
      kind === 'currency' ? { ...options, style: 'currency', currency: code } : options,
    )
  }
}

function niceStep(span: number) {
  if (span <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(span))
  const n = span / power
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power
}

/** The measures of a plot: what the drawing is laid out within. */
interface Frame {
  width: number
  height: number
  top: number
  left: number
  w: number
  h: number
  band: number
}

/** Legend under two series or more, drawn as the chart's own family, with each series' name. */
function Legend({ series, color }: { series: string[]; color: (i: number) => string }) {
  if (series.length < 2) return null
  return (
    <View style={styles.legend}>
      {series.map((s, i) => (
        <View key={s} style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: color(i) }]} />
          <Text style={styles.legendText} numberOfLines={1}>
            {s}
          </Text>
        </View>
      ))}
    </View>
  )
}

function Cartesian({
  spec,
  frame,
  colors,
  focused,
  at,
}: {
  spec: Spec
  frame: Frame
  colors: [string, string, string, string, string, string]
  focused: boolean
  at: number | null
}) {
  const { rows, series, format, x } = spec
  const stacked = spec.stacked && spec.type !== 'line'
  const focus = spec.highlight !== null && spec.type === 'bar' && series.length === 1
  const gradient = 'parts-chart-gradient'
  const tops = rows.map((row) => {
    let total = 0
    return series.map((s) => (total += Math.max(0, num(row[s]))))
  })
  const values = stacked
    ? tops.map((t) => t[t.length - 1] ?? 0)
    : rows.flatMap((row) => series.map((s) => num(row[s])))
  const step = niceStep((Math.max(0, ...values) - Math.min(0, ...values)) / 5)
  const lo = Math.floor(Math.min(0, ...values) / step) * step
  // With one bar in focus there is no scale to read, so the tallest bar fills the plot.
  const hi = focus
    ? Math.max(lo + 1, ...values)
    : Math.max(lo + step, Math.ceil(Math.max(0, ...values) / step) * step)
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, k) => lo + k * step)
  const { top, left, w, h, band } = frame
  const xAt = (i: number) => left + band * i + band / 2
  const y = (v: number) => top + h - ((v - lo) / (hi - lo)) * h
  // Label every nth category so the labels never overlap.
  const longest = Math.max(1, ...rows.map((r) => label(r, x).length))
  const every = Math.max(1, Math.ceil((longest * 6.6 + 10) / band))
  const shown = (i: number) => i % every === 0
  const guide = at === null ? null : rows[Math.min(rows.length - 1, Math.max(0, at))]
  return (
    <View style={styles.plot}>
      <Svg width={frame.width} height={frame.height}>
        <Defs>
          {series.map((s, si) => (
            <LinearGradient key={s} id={`${gradient}-${si}`} x1="0" x2="0" y1="0" y2="1">
              <Stop
                offset="0"
                stopColor={colors[si % colors.length]}
                stopOpacity={stacked ? 0.5 : 0.24}
              />
              <Stop
                offset="1"
                stopColor={colors[si % colors.length]}
                stopOpacity={stacked ? 0.3 : 0.02}
              />
            </LinearGradient>
          ))}
        </Defs>
        {!focus &&
          ticks.map((t) => (
            <G key={t}>
              <Line
                x1={left}
                x2={left + w}
                y1={y(t)}
                y2={y(t)}
                stroke={colors[5]}
                strokeWidth={1}
                strokeDasharray={t === 0 ? undefined : '3 4'}
              />
              <SvgText
                x={left - 8}
                y={y(t) + 4}
                textAnchor="end"
                fill={focused ? colors[1] : colors[4]}
                fontSize={10}
              >
                {format(t, true)}
              </SvgText>
            </G>
          ))}
        {rows.map((row, i) =>
          shown(i) ? (
            <SvgText
              key={i}
              x={xAt(i)}
              y={frame.height - 6}
              textAnchor="middle"
              fill={focus && label(row, x) === spec.highlight ? colors[0] : colors[4]}
              fontSize={10}
              fontWeight={focus && label(row, x) === spec.highlight ? '600' : '400'}
            >
              {label(row, x)}
            </SvgText>
          ) : null,
        )}
        {at !== null && spec.type === 'bar' && !focus && (
          <Rect
            x={left + band * at}
            y={top}
            width={band}
            height={h}
            fill={colors[5]}
            fillOpacity={0.18}
          />
        )}
        {spec.type === 'bar' &&
          rows.map((row, i) => {
            const inner = focus
              ? Math.min(band - 6, Math.max(44, band * 0.5))
              : Math.min(band * 0.7, 72 * Math.max(1, stacked ? 1 : series.length))
            if (focus) {
              const v = num(row[series[0]])
              const on = label(row, x) === spec.highlight
              return (
                <G key={i}>
                  <Rect
                    x={xAt(i) - inner / 2}
                    y={y(v)}
                    width={inner}
                    height={Math.max(2, y(0) - y(v))}
                    rx={7}
                    fill={on ? colors[0] : colors[5]}
                  />
                  {on && (
                    <SvgText
                      x={xAt(i)}
                      y={y(v) - 8}
                      textAnchor="middle"
                      fill={colors[0]}
                      fontSize={11}
                      fontWeight="600"
                    >
                      {format(v, true)}
                    </SvgText>
                  )}
                </G>
              )
            }
            if (stacked)
              return series.map((s, si) => {
                const topAt = y(tops[i][si] ?? 0)
                const base = y(tops[i][si - 1] ?? 0)
                return (
                  <Rect
                    key={`${i}-${s}`}
                    x={xAt(i) - inner / 2}
                    y={topAt}
                    width={inner}
                    height={Math.max(0, base - topAt)}
                    fill={colors[si % colors.length]}
                    rx={si === series.length - 1 ? 4 : 0}
                  />
                )
              })
            const each = inner / series.length
            return series.map((s, si) => {
              const v = num(row[s])
              return (
                <Rect
                  key={`${i}-${s}`}
                  x={xAt(i) - inner / 2 + each * si + 1}
                  y={Math.min(y(v), y(0))}
                  width={Math.max(1, each - 2)}
                  height={Math.abs(y(0) - y(v))}
                  rx={4}
                  fill={colors[si % colors.length]}
                />
              )
            })
          })}
        {(spec.type === 'line' || spec.type === 'area') &&
          series.map((s, si) => {
            const peak = (i: number) => (stacked ? tops[i][si] : num(rows[i][s]))
            const base = (i: number) => (stacked ? (tops[i][si - 1] ?? 0) : 0)
            const points = rows.map((_, i) => `${xAt(i).toFixed(1)},${y(peak(i)).toFixed(1)}`)
            const under = rows
              .map((_, i) => `${xAt(i).toFixed(1)},${y(base(i)).toFixed(1)}`)
              .reverse()
            return (
              <G key={s}>
                {spec.type === 'area' && rows.length > 1 && (
                  <Path
                    d={`M${points.join('L')}L${under.join('L')}Z`}
                    fill={`url(#${gradient}-${si})`}
                  />
                )}
                <Path
                  d={`M${points.join('L')}`}
                  fill="none"
                  stroke={colors[si % colors.length]}
                  strokeWidth={2.2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {rows.map((_, i) =>
                  rows.length <= 16 || i === at ? (
                    <Circle
                      key={i}
                      cx={xAt(i)}
                      cy={y(peak(i))}
                      r={i === at ? 4.5 : 3}
                      fill={colors[si % colors.length]}
                      stroke={colors[5]}
                      strokeWidth={1.5}
                    />
                  ) : null,
                )}
              </G>
            )
          })}
        {at !== null && spec.type !== 'bar' && (
          <Line
            x1={xAt(Math.max(0, at))}
            x2={xAt(Math.max(0, at))}
            y1={top}
            y2={top + h}
            stroke={colors[4]}
            strokeWidth={1}
            strokeDasharray="3 4"
          />
        )}
      </Svg>
      {guide && at !== null && (
        <View
          style={[
            styles.read,
            {
              backgroundColor: colors[0],
              start: Math.min(Math.max(xAt(at) - 60, 0), Math.max(0, frame.width - 120)),
              top,
            },
          ]}
        >
          <Text style={styles.readLabel} numberOfLines={1}>
            {label(guide, x)}
          </Text>
          {series.map((s) => (
            <Text key={s} style={styles.readValue}>
              {series.length > 1 ? `${s} ` : ''}
              {format(num(guide[s]))}
            </Text>
          ))}
        </View>
      )}
      {focused && <Text style={styles.guide}>Touch the chart to read a column</Text>}
    </View>
  )
}

function axisOf(values: number[], zero: boolean) {
  const min = Math.min(...values, ...(zero ? [0] : []))
  const max = Math.max(...values, ...(zero ? [0] : []))
  const step = niceStep((max - min || Math.abs(max) || 1) / 5)
  const lo = Math.floor(min / step) * step
  const hi = Math.max(lo + step, Math.ceil(max / step) * step)
  return {
    lo,
    hi,
    ticks: Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, k) => lo + k * step),
  }
}

/** Points with a numeric x; each series is a colour. The first text key names a point's column. */
function Scatter({
  spec,
  frame,
  colors,
  at,
}: {
  spec: Spec
  frame: Frame
  colors: [string, string, string, string, string, string]
  at: number | null
}) {
  const { rows, series, format, x } = spec
  const name = rows[0]
    ? Object.keys(rows[0]).find((k) => k !== x && typeof rows[0][k] === 'string')
    : undefined
  const ya = axisOf(
    rows.flatMap((r) => series.map((s) => num(r[s]))),
    false,
  )
  const xa = axisOf(
    rows.map((r) => num(r[x])),
    false,
  )
  const { top, left, w, h } = frame
  const px = (v: number) => left + ((v - xa.lo) / (xa.hi - xa.lo)) * w
  const py = (v: number) => top + h - ((v - ya.lo) / (ya.hi - ya.lo)) * h
  const every = Math.max(1, Math.ceil((xa.ticks.length * 44) / w))
  const picked = at == null ? null : rows[Math.min(rows.length - 1, Math.max(0, at))]
  const pickedSeries = at == null ? 0 : Math.max(0, Math.min(series.length - 1, 0))
  return (
    <View style={styles.plot}>
      <Svg width={frame.width} height={frame.height}>
        {ya.ticks.map((t) => (
          <G key={`y${t}`}>
            <Line
              x1={left}
              x2={left + w}
              y1={py(t)}
              y2={py(t)}
              stroke={colors[5]}
              strokeWidth={1}
              strokeDasharray="3 4"
            />
            <SvgText x={left - 8} y={py(t) + 4} textAnchor="end" fill={colors[4]} fontSize={10}>
              {format(t, true)}
            </SvgText>
          </G>
        ))}
        {xa.ticks.map((t, k) =>
          k % every === 0 ? (
            <SvgText
              key={`x${t}`}
              x={px(t)}
              y={frame.height - 6}
              textAnchor="middle"
              fill={colors[4]}
              fontSize={10}
            >
              {Number(t.toFixed(6)).toLocaleString('en-US', {
                notation: Math.abs(t) >= 1e4 ? 'compact' : 'standard',
              })}
            </SvgText>
          ) : null,
        )}
        {series.map((s, si) =>
          rows.map((r, i) => (
            <Circle
              key={`${si}-${i}`}
              cx={px(num(r[x]))}
              cy={py(num(r[s]))}
              r={at === i ? 6.5 : 5}
              fill={colors[si % colors.length]}
              fillOpacity={0.78}
              stroke={colors[5]}
              strokeWidth={1.5}
            />
          )),
        )}
      </Svg>
      {picked && (
        <View
          style={[
            styles.read,
            {
              backgroundColor: colors[0],
              start: Math.min(Math.max(px(num(picked[x])) - 60, 0), Math.max(0, frame.width - 120)),
              top: Math.max(0, py(num(picked[series[pickedSeries]])) - 70),
            },
          ]}
        >
          <Text style={styles.readLabel} numberOfLines={1}>
            {name ? String(picked[name]) : series[pickedSeries]}
          </Text>
          <Text style={styles.readValue}>
            {x} {num(picked[x]).toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </Text>
          <Text style={styles.readValue}>
            {series[pickedSeries]} {format(num(picked[series[pickedSeries]]))}
          </Text>
        </View>
      )}
    </View>
  )
}

function Pie({
  spec,
  frame,
  colors,
  ink,
}: {
  spec: Spec
  frame: Frame
  colors: [string, string, string, string, string, string]
  ink: string
}) {
  const key = spec.series[0]
  const items = spec.rows.map((row) => ({
    at: label(row, spec.x),
    value: Math.max(0, num(key ? row[key] : 0)),
  }))
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1
  const size = Math.max(80, Math.min(200, frame.width < 420 ? frame.width * 0.62 : 200))
  const r = size / 2
  const inner = spec.type === 'donut' ? r * 0.62 : 0
  const point = (radius: number, a: number) =>
    `${(r + radius * Math.cos(a)).toFixed(2)},${(r + radius * Math.sin(a)).toFixed(2)}`
  // Each slice's own start and end angle, accumulated without a running variable: a map that
  // mutates a total re-runs out of order on a re-render, which would swing the slices.
  const slices = items.map((item, i) => {
    const sweep = (item.value / total) * Math.PI * 2
    const a0 =
      -Math.PI / 2 +
      items.slice(0, i).reduce((sum, it) => sum + (it.value / total) * Math.PI * 2, 0)
    return { i, a0, a1: a0 + sweep, large: sweep > Math.PI ? 1 : 0, sweep }
  })
  return (
    <View style={styles.pie}>
      <Svg width={size} height={size}>
        {slices.map(({ i, a0, a1, large, sweep }) => {
          if (sweep >= Math.PI * 2 - 1e-6)
            return inner ? (
              <Circle
                key={i}
                cx={r}
                cy={r}
                r={(r + inner) / 2}
                fill="none"
                stroke={colors[i % colors.length]}
                strokeWidth={r - inner}
              />
            ) : (
              <Circle key={i} cx={r} cy={r} r={r} fill={colors[i % colors.length]} />
            )
          const d = inner
            ? `M${point(r, a0)}A${r},${r} 0 ${large} 1 ${point(r, a1)}L${point(inner, a1)}A${inner},${inner} 0 ${large} 0 ${point(inner, a0)}Z`
            : `M${r},${r}L${point(r, a0)}A${r},${r} 0 ${large} 1 ${point(r, a1)}Z`
          return (
            <Path key={i} d={d} fill={colors[i % colors.length]} stroke="#ffffff" strokeWidth={2} />
          )
        })}
      </Svg>
      <View style={styles.pieLegend}>
        {items.map((item, i) => (
          <View key={i} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors[i % colors.length] }]} />
            <Text style={[styles.legendText, { color: ink }]} numberOfLines={1}>
              {item.at}
            </Text>
            <Text
              style={styles.legendShare}
            >{`${Math.round((item.value / total) * 1000) / 10}%`}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

const chartProps = z.object({
  type: z.enum(['bar', 'line', 'area', 'pie', 'donut', 'scatter']),
  data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))),
  x: z.string().optional(),
  series: z.array(z.string()).optional(),
  format: z.enum(['number', 'currency', 'percent']).optional(),
  currency: z.string().optional(),
  stacked: z.boolean().optional(),
  height: z.number().optional(),
  highlight: z.string().optional(),
})

function toSpec(props: z.infer<typeof chartProps>): Spec | null {
  const rows = ((Array.isArray(props.data) ? props.data : []) as unknown[]).filter(
    (r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r),
  )
  const first = rows[0]
  if (!first) return null
  const x =
    (props.x && props.x in first ? props.x : null) ??
    Object.keys(first).find((k) =>
      props.type === 'scatter' ? typeof first[k] === 'number' : typeof first[k] === 'string',
    ) ??
    Object.keys(first)[0]
  const series = (
    props.series?.length
      ? props.series.filter((s) => typeof s === 'string')
      : Object.keys(first).filter((k) => k !== x && typeof first[k] === 'number')
  ).slice(0, 8)
  const type = (['bar', 'line', 'area', 'pie', 'donut', 'scatter'] as const).includes(props.type)
    ? props.type
    : 'bar'
  return {
    type,
    rows,
    x,
    series,
    stacked: !!props.stacked,
    height: Math.min(
      480,
      Math.max(typeof props.highlight === 'string' ? 88 : 140, props.height ?? 240),
    ),
    format: makeFormat(props.format, props.currency),
    highlight: typeof props.highlight === 'string' ? props.highlight : null,
  }
}

export const Chart = defineComponent({
  name: 'Chart',
  props: chartProps,
  description:
    'Rows of data; x is the category key (a number key for scatter), series the value keys (default: every number key). percent values are like 45; currency is a code like "EUR". highlight names the one x value a single-series bar chart is about: its bar carries its value and the others recede.',
  component: function ChartView({ props }) {
    const skin = useSkin()
    const colors: [string, string, string, string, string, string] = [
      skin.chart(0),
      skin.chart(1),
      skin.chart(2),
      skin.chart(3),
      skin.chart(4),
      skin.chart(5),
    ]
    const [at, setAt] = useState<number | null>(null)
    const [width, setWidth] = useState(0)
    const spec = toSpec(props)
    const pie = spec?.type === 'pie' || spec?.type === 'donut'
    if (!spec || width <= 0) {
      // The display's own height while the frame is not known yet, so what arrives next never
      // jumps the words beneath it.
      return <View style={{ height: spec?.height ?? 240 }} />
    }
    // The y column is as wide as the longest tick label needs: the web's own estimate,
    // 6.4 units of tick type a character, with a column's padding.
    const left =
      Math.max(
        ...(spec.type === 'pie' || spec.type === 'donut'
          ? [0]
          : axisOf(
              spec.rows.flatMap((r) => spec.series.map((s) => num(r[s]))),
              spec.type !== 'scatter',
            ).ticks.map((t) => spec.format(t, true).length)),
      ) *
        6.4 +
      12
    const pad =
      spec.highlight !== null && spec.type === 'bar' && spec.series.length === 1
        ? { top: 24, right: 0, bottom: 24, left: 0 }
        : { top: 10, right: 4, bottom: 26, left }
    const w = Math.max(10, width - pad.left - pad.right)
    const h = Math.max(10, spec.height - pad.top - pad.bottom)
    const frame: Frame = {
      width,
      height: spec.height,
      top: pad.top,
      left: pad.left,
      w,
      h,
      band: w / Math.max(1, spec.rows.length),
    }
    return (
      <View
        onLayout={(event) => {
          const read = Math.floor(event.nativeEvent.layout.width)
          setWidth((drawn) => (drawn === read ? drawn : read))
        }}
      >
        <Pressable
          onPressOut={(event) => {
            if (pie) {
              setAt(null)
              return
            }
            const column = Math.floor(
              (event.nativeEvent.locationX - frame.left) / Math.max(1, frame.band),
            )
            setAt(column >= 0 && column < spec.rows.length ? column : null)
          }}
          accessibilityLabel={`${spec.type} chart of ${spec.series.join(', ')} by ${spec.x}`}
          style={[StyleSheet.absoluteFill, { height: spec.height }]}
        />
        <View style={{ height: spec.height }}>
          {pie ? (
            <Pie spec={spec} frame={frame} colors={colors} ink={skin.ink} />
          ) : spec.type === 'scatter' ? (
            <Scatter spec={spec} frame={frame} colors={colors} at={at} />
          ) : (
            <>
              <Cartesian spec={spec} frame={frame} colors={colors} focused={at === null} at={at} />
              <Legend series={spec.series} color={(i) => colors[Math.max(0, i) % colors.length]} />
            </>
          )}
        </View>
      </View>
    )
  },
})

const styles = StyleSheet.create({
  plot: { alignSelf: 'stretch' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11, lineHeight: 14, maxWidth: 90 },
  legendShare: { fontSize: 11, lineHeight: 14, fontWeight: '600' },
  pie: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch' },
  pieLegend: { flexShrink: 1, gap: 6 },
  read: {
    position: 'absolute',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 2,
  },
  readLabel: { fontWeight: '600', fontSize: 12, lineHeight: 15, color: '#ffffff' },
  readValue: { fontSize: 12, lineHeight: 15, color: '#ffffff' },
  guide: { fontSize: 11, lineHeight: 14, opacity: 0.6, marginTop: 2 },
})
