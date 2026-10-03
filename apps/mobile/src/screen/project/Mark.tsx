import type { ProjectId } from '@vivid/contracts'
import { projects } from '@vivid/state'
import { View } from 'react-native'
import { useTheme, type Colors } from '../../theme'

/* Each hue's colour in the palette. A new hue fails to compile here until it has one. */
const FILL = {
  blue: 'face-blue',
  green: 'face-green',
  orange: 'face-orange',
  magenta: 'face-magenta',
  cyan: 'face-cyan',
  yellow: 'face-yellow',
  red: 'face-red',
  brown: 'face-brown',
} as const satisfies Record<projects.Hue, keyof Colors>

/**
 * A Project's mark: a small filled shape in the Project's own colour, the same colour the web
 * app gives it (`projects.hueOf`). It is a colour and not a folder: a Project is a piece of
 * work, not a place files are put. `size` is its side in points; its corner follows.
 */
export function Mark({ id, size = 12 }: { id: ProjectId; size?: number }) {
  const { colors: c } = useTheme()
  return (
    <View
      pointerEvents="none"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        borderCurve: 'continuous',
        backgroundColor: c[FILL[projects.hueOf(id)]],
      }}
    />
  )
}
