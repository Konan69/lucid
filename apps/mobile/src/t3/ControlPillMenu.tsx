import { MenuView, type MenuComponentRef } from "@react-native-menu/menu";
import { Platform, StyleSheet, View } from "react-native";
import {
  cloneElement,
  isValidElement,
  useRef,
  type ComponentProps,
  type ReactElement,
} from "react";
import { useTheme } from "../theme";

// T3's long-press suppression: releasing a menu gesture must not open the row.
export function ControlPillMenu(props: ComponentProps<typeof MenuView>) {
  const { dark } = useTheme();
  const menu = useRef<MenuComponentRef>(null);
  let children = props.children;
  if (props.shouldOpenOnLongPress && isValidElement(children)) {
    const child = children as ReactElement<{
      onLongPress?: () => void;
      delayLongPress?: number;
    }>;
    children = cloneElement(child, {
      onLongPress: () => {
        child.props.onLongPress?.();
        if (Platform.OS === "android") menu.current?.show();
      },
      delayLongPress: child.props.delayLongPress ?? 350,
    });
  }
  // Android MenuView intercepts row touches before the swipe recognizer can
  // cancel its long press. Keep a native menu anchor behind the actual row,
  // and let Pressable's cancellable long press open it explicitly.
  if (Platform.OS === "android" && props.shouldOpenOnLongPress) {
    return (
      <View>
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <MenuView
            {...props}
            ref={menu}
            themeVariant={dark ? "dark" : "light"}
            style={{ flex: 1 }}
          >
            <View />
          </MenuView>
        </View>
        {children}
      </View>
    );
  }
  return (
    <MenuView {...props} themeVariant={dark ? "dark" : "light"}>
      {children}
    </MenuView>
  );
}
