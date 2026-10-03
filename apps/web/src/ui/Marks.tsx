import {
  MARK_VIEW_BOX,
  SERVICE_MARKS,
  figureKey,
  isServiceMarkId,
  type MarkFigure,
} from '@vivid/marks'
import { cn } from './cn'

/**
 * Draws one shared figure with the DOM's SVG elements. The geometry itself lives in `@vivid/marks`
 * so the native app draws the identical artwork through `react-native-svg`; this file is only the
 * web half of that pair. The last branch is unguarded on purpose: adding a figure variant then
 * fails to typecheck here rather than silently rendering nothing.
 */
function Figure({ figure }: { figure: MarkFigure }) {
  if (figure.kind === 'rect') {
    return (
      <rect
        x={figure.x}
        y={figure.y}
        width={figure.width}
        height={figure.height}
        rx={figure.radius}
        fill={figure.fill}
      />
    )
  }
  if (figure.kind === 'path') {
    return (
      <path d={figure.d} fill={figure.fill} opacity={figure.opacity} transform={figure.transform} />
    )
  }
  if (figure.kind === 'circle') {
    return <circle cx={figure.cx} cy={figure.cy} r={figure.r} fill={figure.fill} />
  }
  if (figure.kind === 'ring') {
    return (
      <circle
        cx={figure.cx}
        cy={figure.cy}
        r={figure.r}
        fill={figure.fill}
        stroke={figure.stroke}
        strokeWidth={figure.strokeWidth}
      />
    )
  }
  return (
    <text
      x={figure.x}
      y={figure.y}
      textAnchor="middle"
      fontFamily="system-ui, sans-serif"
      fontSize={figure.fontSize}
      fontWeight={figure.fontWeight}
      fill={figure.fill}
    >
      {figure.text}
    </text>
  )
}

/**
 * The service marks for the Connections in play, drawn as a row so it reads at a glance. A service
 * Vivid has no artwork for is left out rather than shown as a placeholder: in a dense row a
 * generic tile is noise, and the accompanying text already names it.
 */
export function ServiceMarks({
  services,
  size = 16,
  className,
}: {
  services: string[]
  size?: number
  className?: string
}) {
  if (services.length === 0) return null
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      {services.map((service) => {
        if (!isServiceMarkId(service)) return null
        const mark = SERVICE_MARKS[service]
        // SAFETY: React forwards this validated CSS custom property to the element.
        const markStyle = { '--tool-size': `${size}px` } as React.CSSProperties
        return (
          <span
            key={service}
            title={mark.label}
            className="inline-flex size-(--tool-size) shrink-0 items-center justify-center overflow-hidden rounded-[4px] edge"
            style={markStyle}
          >
            <svg viewBox={MARK_VIEW_BOX} className="size-full" aria-hidden>
              {mark.figures.map((figure) => (
                <Figure key={figureKey(figure)} figure={figure} />
              ))}
            </svg>
          </span>
        )
      })}
    </span>
  )
}
