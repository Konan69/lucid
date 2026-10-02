import type { ReactNode } from 'react'
import { View } from 'react-native'
import { useTheme } from '../../theme'
import { Label, radius } from '../../ui/ui'

/** Displays share a quiet frame; each kind owns its native reading or answering interaction. */
export function Frame({ title, children }: { title?: string; children: ReactNode }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        marginTop: 12,
        padding: 16,
        gap: 12,
        borderRadius: radius.card,
        backgroundColor: c['surface-3'],
        overflow: 'hidden',
      }}
    >
      {title !== undefined && (
        <Label accessibilityRole="header" size="footnote">
          {title}
        </Label>
      )}
      {children}
    </View>
  )
}
