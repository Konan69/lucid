import { Text, View } from 'react-native'
import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg'
import {
  MARK_VIEW_BOX,
  SERVICE_MARKS,
  figureKey,
  isServiceMarkId,
  type MarkFigure,
  type ServiceMark as Artwork,
} from '@vivid/marks'
import { useTheme } from '../theme'

/**
 * Discord, which Vivid texts on but does not act through, so it is not among the Connection marks
 * of `@vivid/marks`. Its white mark on Discord's blurple tile, the way the other messaging apps are
 * drawn; the path is the web's `logos/discord.svg`, scaled from its 256 by 199 box.
 */
const DISCORD: Artwork = {
  label: 'Discord',
  figures: [
    { kind: 'rect', x: 0, y: 0, width: 24, height: 24, radius: 5, fill: '#5865F2' },
    {
      kind: 'path',
      fill: '#fff',
      opacity: 1,
      transform: 'translate(5 6.56) scale(0.0547)',
      d: 'M216.856 16.597A208.5 208.5 0 0 0 164.042 0c-2.275 4.113-4.933 9.645-6.766 14.046q-29.538-4.442-58.533 0c-1.832-4.4-4.55-9.933-6.846-14.046a207.8 207.8 0 0 0-52.855 16.638C5.618 67.147-3.443 116.4 1.087 164.956c22.169 16.555 43.653 26.612 64.775 33.193A161 161 0 0 0 79.735 175.3a136.4 136.4 0 0 1-21.846-10.632a109 109 0 0 0 5.356-4.237c42.122 19.702 87.89 19.702 129.51 0a132 132 0 0 0 5.355 4.237a136 136 0 0 1-21.886 10.653c4.006 8.02 8.638 15.67 13.873 22.848c21.142-6.58 42.646-16.637 64.815-33.213c5.316-56.288-9.08-105.09-38.056-148.36M85.474 135.095c-12.645 0-23.015-11.805-23.015-26.18s10.149-26.2 23.015-26.2s23.236 11.804 23.015 26.2c.02 14.375-10.148 26.18-23.015 26.18m85.051 0c-12.645 0-23.014-11.805-23.014-26.18s10.148-26.2 23.014-26.2c12.867 0 23.236 11.804 23.015 26.2c0 14.375-10.148 26.18-23.015 26.18',
    },
  ],
}

/**
 * Draws one shared figure with `react-native-svg`. The geometry lives in `@vivid/marks` so the web
 * draws the identical artwork through the DOM's SVG elements; this file is only the native half.
 * Every kind is a named case: adding a figure variant then fails lint and typecheck here rather
 * than silently rendering nothing.
 */
function Figure({ figure }: { figure: MarkFigure }) {
  switch (figure.kind) {
    case 'rect':
      return (
        <Rect
          x={figure.x}
          y={figure.y}
          width={figure.width}
          height={figure.height}
          rx={figure.radius}
          fill={figure.fill}
        />
      )
    case 'path':
      return (
        <Path
          d={figure.d}
          fill={figure.fill}
          opacity={figure.opacity}
          transform={figure.transform}
        />
      )
    case 'circle':
      return <Circle cx={figure.cx} cy={figure.cy} r={figure.r} fill={figure.fill} />
    case 'ring':
      return (
        <Circle
          cx={figure.cx}
          cy={figure.cy}
          r={figure.r}
          fill={figure.fill}
          stroke={figure.stroke}
          strokeWidth={figure.strokeWidth}
        />
      )
    case 'glyph':
      return (
        <SvgText
          x={figure.x}
          y={figure.y}
          textAnchor="middle"
          fontFamily="System"
          fontSize={figure.fontSize}
          fontWeight={figure.fontWeight}
          fill={figure.fill}
        >
          {figure.text}
        </SvgText>
      )
  }
}

/**
 * One service's mark, sized for a Connection row. A service Vivid has no artwork for gets its
 * initial on a well, as the web's `Mark` does: unlike the dense web row this is a single tile with
 * its own slot, so leaving it empty would read as a broken image. It was a plug outline until 26
 * October 2026, which the developer asked to be removed.
 */
export function ServiceMark({ service, size = 24 }: { service: string; size?: number }) {
  const { colors: c } = useTheme()
  const mark = isServiceMarkId(service)
    ? SERVICE_MARKS[service]
    : service === 'discord'
      ? DISCORD
      : undefined
  return (
    <View
      accessibilityLabel={mark ? mark.label : service}
      accessibilityRole="image"
      style={{ width: size, height: size, borderRadius: 5, overflow: 'hidden' }}
    >
      {mark ? (
        <Svg viewBox={MARK_VIEW_BOX} width="100%" height="100%">
          {mark.figures.map((figure) => (
            <Figure key={figureKey(figure)} figure={figure} />
          ))}
        </Svg>
      ) : (
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: c['surface-well'],
          }}
        >
          <Text
            style={{ fontSize: size * 0.5, fontWeight: '600', color: c['foreground-secondary'] }}
          >
            {service.trim().slice(0, 1).toLocaleUpperCase()}
          </Text>
        </View>
      )}
    </View>
  )
}
