import { isServiceMarkId } from '@vivid/marks'
import { Option } from 'effect'
import { Image, View } from 'react-native'
import { useTheme } from '../../theme'
import { ServiceMark } from '../../ui/Mark'

/** The one size asked of the icon service; see `Logo`. */
const ICON_SIZE = 128

/**
 * A service's artwork in a rounded square, for a row of the Integrations sheet.
 *
 * The artwork Vivid draws itself wins (`ServiceMark`, the shared figures of `@vivid/marks`): it
 * is sharp at any size and needs no network. A service it has none for takes the icon of its
 * site, at the address the server sends, which is the only artwork most of the catalog has. A
 * service with neither gets the phone's own stand-in, the plug `ServiceMark` falls back to.
 *
 * The order and the icon address are the web's (`artOf` in
 * `apps/web/src/screen/integration/Mark.tsx`). The web also bundles a logo file for each
 * well-known service and draws an initial on a colour for the rest; the phone bundles no such
 * files, so those two steps are not here.
 *
 * It is decoration beside the service's name, which is what a screen reader says.
 */
export function Logo({
  service,
  mark,
  size = 40,
}: {
  /** The service's id, which is how the shared artwork is named. */
  service: string
  /** The address of the service's icon, without a size, when the server knows one. */
  mark: Option.Option<string>
  size?: number
}) {
  const { colors: c } = useTheme()
  const drawn = isServiceMarkId(service) ? Option.none<string>() : mark
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        // A quarter of the side, less a little: the corner of an app icon at this size.
        borderRadius: Math.round(size * 0.22),
        borderCurve: 'continuous',
        overflow: 'hidden',
        // What shows while a site's icon is on its way, so the row never has a hole in it.
        backgroundColor: Option.isSome(drawn) ? c['wash-hover'] : 'transparent',
      }}
    >
      {Option.isSome(drawn) ? (
        // The icon service answers only at its own sizes and falls to the 16-pixel favicon for
        // any other; 128 is the size it has that covers this row at three times its drawn size.
        <Image
          source={{ uri: `${drawn.value}&sz=${ICON_SIZE}` }}
          style={{ width: size, height: size }}
        />
      ) : (
        <ServiceMark service={service} size={size} />
      )}
    </View>
  )
}
