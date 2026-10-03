import { View } from 'react-native'
import { useTheme } from '../theme'
import { useAgain } from '../ui/Recover'
import { Button, Face, GUTTER, Label } from '../ui/ui'

/**
 * What is shown when the app itself failed to draw. Nothing is lost by it: Threads and everything
 * Vivid is doing live on the server, and what was being written is kept on this phone
 * (`data/drafts.ts`). The one way on is to draw the screen again, which is enough when the failure
 * was one bad moment; a phone has no reload to offer beside it.
 *
 * It is drawn above the session and the navigator, so it reads nothing from either: the palette,
 * Vivid's face, two sentences and a button.
 */
export function Broken() {
  const again = useAgain()
  const { colors: c } = useTheme()
  return (
    <View
      accessibilityRole="alert"
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingHorizontal: GUTTER + 12,
        backgroundColor: c['surface-0'],
      }}
    >
      <Label size="headline" style={{ textAlign: 'center' }}>
        This screen could not be shown
      </Label>
      <Label size="label" tone="ink-2" style={{ textAlign: 'center', maxWidth: 300 }}>
        Something went wrong while drawing it. Your threads and what you were writing are safe.
      </Label>
      <View style={{ marginTop: 14 }}>
        <Button kind="primary" label="Try again" onPress={again} />
      </View>
    </View>
  )
}
