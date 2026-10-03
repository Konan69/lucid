import type { Project } from '@vivid/contracts'
import { View } from 'react-native'
import { tick } from '../../data/haptics'
import { useTheme } from '../../theme'
import { EDGE, Label, Press } from '../../ui/ui'
import { Mark } from './Mark'
import { scope } from './scope'

/** The chip's height. Each segment's touch area reaches past it to a full 44-point target. */
const HEIGHT = 32
const REACH = (44 - HEIGHT) / 2

/**
 * The scope, beside the workspace's name: two segments, "All" and the Project the view is
 * narrowed to, with the Project's the chosen one. It is only drawn while there is a scope, so
 * its being there says the list under it is not everything; "All" is the one tap out, and the
 * Project's own segment opens its page.
 *
 * It is a pair of segments and not a chip with a cross: a cross reads as "remove this Project",
 * and what the Person is choosing between is two views of the same Threads. The web app's chip
 * is the same shape (`apps/web/src/screen/project/Chip.tsx`).
 */
export function ScopeChip({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const { colors: c } = useTheme()
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="Scope"
      style={{
        flexShrink: 1,
        height: HEIGHT,
        padding: 2,
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: HEIGHT / 2,
        borderWidth: EDGE,
        borderColor: c.border,
        backgroundColor: c['surface-well'],
      }}
    >
      <Press
        accessibilityRole="radio"
        accessibilityState={{ selected: false }}
        accessibilityLabel="All threads"
        hitSlop={{ top: REACH, bottom: REACH, left: 8 }}
        onPress={() => {
          tick()
          scope.leave()
        }}
        style={({ pressed }) => ({
          height: HEIGHT - 6,
          paddingHorizontal: 10,
          justifyContent: 'center',
          borderRadius: HEIGHT / 2,
          backgroundColor: pressed ? c['row-hover'] : 'transparent',
        })}
      >
        <Label size="caption" tone="ink-3" style={{ fontWeight: '600' }}>
          All
        </Label>
      </Press>
      <Press
        accessibilityRole="radio"
        accessibilityState={{ selected: true }}
        accessibilityLabel={`${project.name}. Open project`}
        hitSlop={{ top: REACH, bottom: REACH, right: 8 }}
        onPress={onOpen}
        containerStyle={{ flexShrink: 1 }}
        style={({ pressed }) => ({
          height: HEIGHT - 6,
          paddingLeft: 9,
          paddingRight: 11,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          borderRadius: HEIGHT / 2,
          borderWidth: EDGE,
          borderColor: c.border,
          backgroundColor: pressed ? c['row-hover'] : c['grouped-card'],
        })}
      >
        <Mark id={project.id} size={10} />
        <Label numberOfLines={1} size="caption" style={{ flexShrink: 1, fontWeight: '600' }}>
          {project.name}
        </Label>
      </Press>
    </View>
  )
}
