import { chartScale, chartShares, chartValue, type ShownChart } from '@vivid/state'
import { View } from 'react-native'
import Svg, { Circle, G, Line, Polyline, Rect, Text } from 'react-native-svg'
import { useTheme } from '../../theme'
import { Label } from '../../ui/ui'

/** The web's six series colours, in order, read from the native theme. */
const COLORS = [
  'accent',
  'face-cyan',
  'face-orange',
  'face-green',
  'face-magenta',
  'face-yellow',
] as const
// These are SVG drawing units, not a guessed device width. The plot scales at the actual reply width.
const DRAWING = { width: 320, height: 200, left: 8, right: 8, top: 22, bottom: 32 } as const
const { width: W, height: H, left: LEFT, right: RIGHT } = DRAWING

/** Series colours repeat after six, which a share chart with more parts relies on. */
function usePaint() {
  const { colors } = useTheme()
  return (index: number) => colors[COLORS[index % COLORS.length]]
}

/** Phone-sized SVG keeps all values in its accessible name while using fewer visible axis labels. */
export function Chart({ chart }: { chart: ShownChart }) {
  return (
    <View accessible accessibilityLabel={readingOf(chart)} style={{ gap: 8 }}>
      {chart.kind === 'share' ? <Share chart={chart} /> : <Plot chart={chart} />}
      {(chart.series.length > 1 || chart.kind === 'share') && <Legend chart={chart} />}
    </View>
  )
}

/** Four axis labels at most leave room for readable type, while the data and zero scale stay shared. */
function Plot({ chart }: { chart: ShownChart }) {
  const { colors: c } = useTheme()
  const { top, y, slot } = chartScale(chart, DRAWING)
  const every = Math.ceil(chart.labels.length / 4)
  return (
    <View style={{ width: '100%', aspectRatio: W / H }}>
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${H}`}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <Line x1={LEFT} x2={W - RIGHT} y1={y(0)} y2={y(0)} stroke={c.border} strokeWidth={1} />
        <Line
          x1={LEFT}
          x2={W - RIGHT}
          y1={y(top)}
          y2={y(top)}
          stroke={c.border}
          strokeWidth={1}
          strokeDasharray="3 4"
        />
        <Text x={LEFT} y={y(top) - 3} fill={c['foreground-secondary']} fontSize={16}>
          {chartValue(top, chart.unit)}
        </Text>
        {chart.kind === 'bar' ? (
          <Bars chart={chart} slot={slot} y={y} />
        ) : (
          <Lines chart={chart} slot={slot} y={y} />
        )}
        {chart.labels.map((label, index) =>
          index % every === 0 ? (
            <Text
              key={label}
              x={LEFT + slot * index + slot / 2}
              y={H - 8}
              textAnchor="middle"
              fill={c['foreground-secondary']}
              fontSize={16}
            >
              {label.length > 10 ? `${label.slice(0, 9)}…` : label}
            </Text>
          ) : null,
        )}
      </Svg>
    </View>
  )
}

/** Bars are grouped by label, including negative values below zero. */
function Bars({
  chart,
  slot,
  y,
}: {
  chart: ShownChart
  slot: number
  y: (value: number) => number
}) {
  const paint = usePaint()
  const group = slot * 0.72
  const bar = group / chart.series.length
  return chart.series.map((series, order) =>
    series.values.map((value, index) => (
      <Rect
        // A bar's identity is its series and place, exactly as on the web.
        // oxlint-disable-next-line react/no-array-index-key
        key={`${series.name}:${index}`}
        x={LEFT + slot * index + (slot - group) / 2 + bar * order}
        y={Math.min(y(value), y(0))}
        width={Math.max(bar - 2, 1)}
        height={Math.max(Math.abs(y(value) - y(0)), 1)}
        rx={3}
        fill={paint(order)}
      />
    )),
  )
}

/** Dots only mark short series; fewer markers keep dense phone plots legible. */
function Lines({
  chart,
  slot,
  y,
}: {
  chart: ShownChart
  slot: number
  y: (value: number) => number
}) {
  const paint = usePaint()
  const x = (index: number) => LEFT + slot * index + slot / 2
  return chart.series.map((series, order) => (
    <G key={series.name}>
      <Polyline
        points={series.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
        fill="none"
        stroke={paint(order)}
        strokeWidth={2.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {series.values.length <= 12 &&
        series.values.map((value, index) => (
          // A point has no identity apart from its position in the series.
          // oxlint-disable-next-line react/no-array-index-key
          <Circle key={index} cx={x(index)} cy={y(value)} r={3} fill={paint(order)} />
        ))}
    </G>
  ))
}

/** Shares compare lengths on one line; negative values count as none on both surfaces. */
function Share({ chart }: { chart: ShownChart }) {
  const paint = usePaint()
  const parts = chartShares(chart)
  return (
    <Svg
      width="100%"
      height={28}
      viewBox={`0 0 ${W} 28`}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {parts.map((part, index) => {
        const x = part.from * W
        return (
          <Rect
            key={part.label}
            x={x}
            y={0}
            width={Math.max(part.share * W - 2, 1)}
            height={28}
            rx={6}
            fill={paint(index)}
          />
        )
      })}
    </Svg>
  )
}

/** Names and percentages use the same computation as the picture and web legend. */
function Legend({ chart }: { chart: ShownChart }) {
  const paint = usePaint()
  const names =
    chart.kind === 'share'
      ? chartShares(chart).map((part) => `${part.label} · ${Math.round(part.share * 100)}%`)
      : chart.series.map((series) => series.name)
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {names.map((name, index) => (
        <View key={name} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: paint(index) }} />
          <Label size="caption" tone="ink-2">
            {name}
          </Label>
        </View>
      ))}
    </View>
  )
}

/** The chart's native accessible name includes the same rows as the web's screen-reader table. */
function readingOf(chart: ShownChart): string {
  const rows = chart.labels.map((label, index) =>
    [
      label,
      ...chart.series.map((series) => {
        const value = series.values[index]
        return value === undefined
          ? series.name
          : `${series.name}: ${chartValue(value, chart.unit)}`
      }),
    ].join(', '),
  )
  return (chart.title === undefined ? rows : [chart.title, ...rows]).join('\n')
}
