/**
 * An image imported as a module. Metro bundles the file with the others of its density
 * (`menu.png`, `menu@2x.png`, `menu@3x.png`) and hands back the asset, which React Native takes
 * as an image's source and picks the right density from.
 */
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native'

  const source: ImageSourcePropType
  export default source
}
