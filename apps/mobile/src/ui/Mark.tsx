import { View } from 'react-native'
import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg'
import { Plug } from 'lucide-react-native'
import {
  MARK_VIEW_BOX,
  SERVICE_MARKS,
  figureKey,
  isServiceMarkId,
  type MarkFigure,
} from '@vivid/marks'
import { useTheme } from '../theme'

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
 * One service's mark, sized for a Connection row. A service Vivid has no artwork for falls back to
 * a plug outline: unlike the dense web row this is a single tile with its own slot, so leaving it
 * empty would read as a broken image.
 */
export function ServiceMark({ service, size = 24 }: { service: string; size?: number }) {
  const { colors: c } = useTheme()
  const mark = isServiceMarkId(service) ? SERVICE_MARKS[service] : undefined
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
        <Plug size={size} color={c['foreground-secondary']} />
      )}
    </View>
  )
}
