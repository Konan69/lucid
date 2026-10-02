import { MenuView, type MenuComponentRef } from '@react-native-menu/menu'
import { Platform, StyleSheet, View } from 'react-native'
import {
  cloneElement,
  isValidElement,
  useState,
  type ComponentProps,
  type ReactElement,
} from 'react'
import { hold } from '../data/haptics'
import { useTheme } from '../theme'

// T3's long-press suppression: releasing a menu gesture must not open the row.
export function ControlPillMenu(props: ComponentProps<typeof MenuView>) {
  const { dark } = useTheme()
  // The native menu is kept as state, not a ref: the long press that opens it is wired onto the
  // child below while rendering, and a handler built during render may not close over a ref.
  const [menu, setMenu] = useState<MenuComponentRef | null>(null)
  const openMenu = () => {
    if (Platform.OS !== 'android' || menu === null) return
    // Felt at the moment the menu appears, which is the moment the hold is long enough.
    hold()
    menu.show()
  }
  let children = props.children
  if (props.shouldOpenOnLongPress && isValidElement(children)) {
    // SAFETY: isValidElement confirms that children is a React element before its props are read.
    const child = children as ReactElement<{
      onLongPress?: () => void
      delayLongPress?: number
    }>
    const childProps = child.props
    children = cloneElement(child, {
      onLongPress: () => {
        if (childProps.onLongPress !== undefined) childProps.onLongPress()
        openMenu()
      },
      delayLongPress: childProps.delayLongPress ?? 350,
    })
  }
  // Android MenuView intercepts row touches before the swipe recognizer can
  // cancel its long press. Keep a native menu anchor behind the actual row,
  // and let Pressable's cancellable long press open it explicitly.
  if (Platform.OS === 'android' && props.shouldOpenOnLongPress) {
    return (
      <View>
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <MenuView
            {...props}
            ref={setMenu}
            themeVariant={dark ? 'dark' : 'light'}
            style={{ flex: 1 }}
          >
            <View />
          </MenuView>
        </View>
        {children}
      </View>
    )
  }
  return (
    <MenuView {...props} themeVariant={dark ? 'dark' : 'light'}>
      {children}
    </MenuView>
  )
}
