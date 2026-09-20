import { MenuView, type MenuComponentRef } from '@react-native-menu/menu'
import { Platform, StyleSheet, View } from 'react-native'
import {
  cloneElement,
  isValidElement,
  useEffectEvent,
  useRef,
  type ComponentProps,
  type ReactElement,
} from 'react'
import { useTheme } from '../theme'

function showAndroidMenu(menu: { readonly current: MenuComponentRef | null }) {
  const currentMenu = menu.current
  if (currentMenu !== null) currentMenu.show()
}

// T3's long-press suppression: releasing a menu gesture must not open the row.
export function ControlPillMenu(props: ComponentProps<typeof MenuView>) {
  const { dark } = useTheme()
  const menu = useRef<MenuComponentRef>(null)
  const openMenu = useEffectEvent(() => {
    if (Platform.OS === 'android') showAndroidMenu(menu)
  })
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
            ref={menu}
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
