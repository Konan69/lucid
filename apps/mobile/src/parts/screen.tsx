import { defineComponent } from '@openuidev/react-lang'
import { Option } from 'effect'
import { Monitor } from 'lucide-react-native'
import { StyleSheet, View } from 'react-native'
import { z } from 'zod/v4'
import { viewerPermission } from '../data/computer'
import { LiveState, useLive, useLiveData } from '../data/live'
import { drawsScreen, Live } from '../screen/computer/Live'

/**
 * The web's `Screen` (`apps/web/vendor/openui/screen.tsx`) on the phone: Vivid's Computer's screen as
 * it is now, in a 16:10 frame on the desk's dark ground. It is the app's own glass (`Live`, the
 * machine provider's viewer page), watch-only, so a touch on the card never reaches the machine.
 * A machine that is not running, a relayed screen only the web panel can draw, and an install
 * without the web view all show the screen glyph instead (`data/computer.ts` `viewerPermission`).
 */
export const Screen = defineComponent({
  name: 'Screen',
  props: z.object({ alt: z.string() }),
  description:
    "Your Computer's screen as it is now, live and watch-only, for work you did on it; alt says what is on it.",
  component: function Watched({ props }) {
    const data = useLiveData()
    const state = useLive(data.live.computer)
    const viewer = LiveState.$is('Ready')(state)
      ? Option.filter(viewerPermission(state.value.computer), drawsScreen)
      : Option.none()
    return (
      <View
        style={styles.frame}
        accessible
        accessibilityRole="image"
        accessibilityLabel={props.alt}
      >
        {Option.match(viewer, {
          onNone: () => (
            <View style={styles.resting}>
              <Monitor size={20} strokeWidth={1.6} color="#ffffff" />
            </View>
          ),
          onSome: (live) => (
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              {/* A new machine start has a new viewer; the one on the glass is not carried over. */}
              <Live
                key={live.address}
                address={live.address}
                expiresAt={live.expiresAt}
                control={false}
              />
            </View>
          ),
        })}
      </View>
    )
  },
})

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: 16 / 10,
    borderRadius: 16,
    overflow: 'hidden',
    // The web's `desktop-wallpaper` at its middle stop: the desk the screen sits on.
    backgroundColor: '#23262e',
  },
  resting: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})
