import { Platform, type ViewStyle } from 'react-native'

/**
 * How far a shape stands off the page, as one `boxShadow`. Nothing in the app writes a shadow by
 * hand: a floating shape names its tier here.
 *
 * The layers are the smooth shadow plugin's, the web's rule for elevation (`DESIGN.md`,
 * "Elevation"; `docs/08-design-language.md`), ported value for value from shadow-plugin 2.1.1
 * (`dist/shadow-plugin.css`, `--smooth-shadow-sm` and `--smooth-shadow-md`; Florian Kiem, MIT).
 * Each is a stack of soft layers that fall off the way a real shadow does, where one wide blur
 * reads as a grey fog round the shape: the phone's composer had that (`0 6px 28px` at 15%), and
 * the owner asked why it was not the plugin's (6 October 2026).
 *
 * - `sm`: a compact floating control, such as the name under Vivid's avatar.
 * - `md`: what floats over the page, such as the composer.
 *
 * The plugin's ring is its last layer: a hairline that is part of the shadow, so the edge runs
 * into it instead of sitting beside it as a border. A shape with a ring has no border as well.
 * Its colour is the theme's `border`, as the web sets it (`--smooth-ring-color`, `tokens.css`).
 */
const STACK = {
  sm: [
    '0 18px 47px 0 rgba(0, 0, 0, 0.03)',
    '0 7.5px 19px 0 rgba(0, 0, 0, 0.02)',
    '0 4px 10.5px 0 rgba(0, 0, 0, 0.02)',
    '0 2.3px 5.8px 0 rgba(0, 0, 0, 0.01)',
    '0 1.2px 3.1px 0 rgba(0, 0, 0, 0.01)',
    '0 0.5px 1.3px 0 rgba(0, 0, 0, 0.01)',
  ],
  md: [
    '0 17.54px 23.39px 0 rgba(0, 0, 0, 0.04)',
    '0 9.4px 12.5px 0 rgba(0, 0, 0, 0.03)',
    '0 5.25px 7px 0 rgba(0, 0, 0, 0.02)',
    '0 2.79px 3.72px -2px rgba(0, 0, 0, 0.01)',
    '0 1.16px 1.5px 0 rgba(0, 0, 0, 0.01)',
  ],
} as const

export type Tier = keyof typeof STACK

/**
 * Whether this device draws a shadow cast outside a shape. Android before 9 (API 28) does not:
 * React Native skips an outset `boxShadow` there (`BackgroundStyleApplicator.setBoxShadow`), and
 * the app still installs on those versions. A shape whose only edge is its shadow's ring would
 * have no edge at all there, so it is given a plain hairline instead (`lifted`).
 */
const CASTS = Platform.OS !== 'android' || Platform.Version >= 28

/**
 * The stack alone (the plugin's `smooth-shadow-*`), for a shape whose material draws its own
 * edge: the system's glass, or a solid disc. Where no shadow is cast the shape still has that
 * edge, so nothing takes the stack's place.
 */
export const cast = (tier: Tier): ViewStyle => ({ boxShadow: STACK[tier].join(', ') })

/**
 * The stack with the hairline ring as its last layer (the plugin's `smooth-shadow-ring-*`), for
 * a shape that has no edge of its own. `ring` is the theme's `border`. Where no shadow is cast
 * the ring is drawn as a border, which is the one case a floating shape has one.
 */
export const lifted = (tier: Tier, ring: string): ViewStyle =>
  CASTS
    ? { boxShadow: [...STACK[tier], `0 0 0 1px ${ring}`].join(', ') }
    : { borderWidth: 1, borderColor: ring }
