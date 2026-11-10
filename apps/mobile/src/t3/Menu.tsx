import { MenuView, type MenuAction, type MenuComponentRef } from '@react-native-menu/menu'
import { Platform, StyleSheet, View, type PressableStateCallbackType } from 'react-native'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { hold } from '../data/haptics'
import { useTheme } from '../theme'
import { Press } from '../ui/motion/Pressable'

/** The system's menu in the app's palette, opened by a tap on what it wraps. */
function ControlPillMenu(props: ComponentProps<typeof MenuView>) {
  const { dark } = useTheme()
  return <MenuView {...props} themeVariant={dark ? 'dark' : 'light'} />
}

/**
 * How long a finger rests on a row before the row is being held, not tapped. It is a little
 * under the half second iOS takes to bring up a menu, so a hold never also opens the row.
 */
const HELD_AFTER_MS = 350

/**
 * A row that opens on a tap and offers the system's menu on a hold.
 *
 * The reference is T3 Code mobile's `ControlPillMenu` with `shouldOpenOnLongPress`
 * (`src/components/ControlPill.tsx`): the native menu wraps the row's pressable. That only works
 * there because the reference patches the menu library's native code. Unpatched, the library's
 * iOS view is a full-size `UIButton` mounted in front of its React children
 * (`ios/NewArch/MenuView.mm` sets it as the `contentView`, and a child is inserted under it), so
 * the button takes every touch and a pressable inside the menu is never pressed: on an iPhone no
 * Thread row in the drawer opened. The reference's patch makes that button take no touches while
 * the menu opens on a hold (`ios/Shared/MenuViewImplementation.swift`, `isUserInteractionEnabled`).
 * A patch to native code needs a new binary, so Vivid puts the views in an order that needs none:
 *
 * - iOS: the pressable is the menu's parent, not its child. The touch still lands on the menu's
 *   button, and React Native hands it to the menu's view and then up to the pressable around it,
 *   which opens the row. A hold is the button's own: UIKit brings up the menu.
 * - Android: the library's view takes the row's touches before the swipe around the row can
 *   cancel a hold, so the menu is only an anchor behind the row that takes no touches, and the
 *   pressable's own hold opens it. The reference draws its own menu there instead.
 *
 * On both, a hold must not also open the row when the finger lifts. The pressable is given a
 * hold of its own for that: React Native does not press what was held.
 */
export function HoldMenu({
  title,
  actions,
  onChoose,
  onPress,
  children,
}: {
  title: string
  actions: MenuAction[]
  /** The id of the row of the menu that was chosen. */
  onChoose: (id: string) => void
  onPress: () => void
  children: (state: PressableStateCallbackType) => ReactNode
}) {
  const { dark } = useTheme()
  // The native menu is kept as state, not a ref: the hold that opens it is a handler built while
  // rendering, and a handler built during render may not close over a ref.
  const [menu, setMenu] = useState<MenuComponentRef | null>(null)
  const anchored = {
    title,
    actions,
    themeVariant: dark ? 'dark' : 'light',
    onPressAction: ({ nativeEvent }: { nativeEvent: { event: string } }) =>
      onChoose(nativeEvent.event),
  } as const

  if (Platform.OS === 'ios') {
    return (
      <Press
        accessibilityRole="button"
        onPress={onPress}
        // Nothing to do here: UIKit opens the menu. It is given so the hold does not open the row.
        onLongPress={() => undefined}
        delayLongPress={HELD_AFTER_MS}
      >
        {(state) => (
          <MenuView {...anchored} shouldOpenOnLongPress>
            {children(state)}
          </MenuView>
        )}
      </Press>
    )
  }
  return (
    <View>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <MenuView {...anchored} ref={setMenu} shouldOpenOnLongPress style={{ flex: 1 }}>
          <View />
        </MenuView>
      </View>
      <Press
        accessibilityRole="button"
        onPress={onPress}
        onLongPress={() => {
          if (menu === null) return
          // Felt at the moment the menu appears, which is the moment the hold is long enough.
          hold()
          menu.show()
        }}
        delayLongPress={HELD_AFTER_MS}
      >
        {children}
      </Press>
    </View>
  )
}
