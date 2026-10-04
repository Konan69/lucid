import type { PersonSummary } from '@vivid/contracts'
import type { FaceMood } from '@vivid/marks'
import { useNavigation, type ParamListBase } from '@react-navigation/native'
import {
  useAnimatedHeaderHeight,
  type NativeStackHeaderItem,
  type NativeStackHeaderItemButton,
  type NativeStackNavigationOptions,
  type NativeStackNavigationProp,
} from '@react-navigation/native-stack'
import { Option } from 'effect'
import type { LucideIcon } from 'lucide-react-native'
import { useLayoutEffect, useRef } from 'react'
import { Animated, Platform, useWindowDimensions, View } from 'react-native'
import { Faces } from './Avatar'
import { GLASS_SUPPORTED } from './Glass'
import { Face, IconButton, Label, TARGET, type Tone } from './ui'

/**
 * What a screen puts in the system's navigation bar: its title and at most a couple of actions.
 *
 * The bar is the platform's own (`GLASS_HEADER` in `ui/stack.ts`). On iOS every action is a real
 * `UIBarButtonItem`, so on iOS 26 the system draws it, and the way back, as round liquid glass;
 * nothing here draws a button. A screen says what it wants by rendering `Bar` or `StandingBar`,
 * which draw nothing themselves.
 *
 * Ported from T3 Code mobile `src/native/StackHeader.tsx` (`NativeStackScreenOptions`,
 * `NativeHeaderToolbar`) and its uses in `src/features/settings/SettingsRouteScreen.tsx` and
 * `src/features/threads/ThreadRouteScreen.tsx`. What is kept:
 * - Options reach the bar through `navigation.setOptions` in a `useLayoutEffect`, before paint,
 *   so a pushed screen is never seen under the route's name. The reference does this, and it is
 *   React Navigation's own documented way; a screen's options cannot be derived during render.
 * - The options are applied again only when what they say has changed (the reference's
 *   `optionsSignature`), because `setOptions` re-renders the navigator and an unconditional call
 *   would re-enter it on every render.
 * - A bar item's handler is a stable function that calls the newest one (the reference's
 *   `stabilizeOptionFunctions`), so a handler that closes over fresh state does not re-apply the
 *   options and is never stale.
 * - Actions are `unstable_headerRightItems` on iOS. That option is iOS-only, so Android gets the
 *   same actions as `headerRight` on its solid bar.
 *
 * What differs, and why:
 * - The reference compares options by walking any object and reading function source. Here the
 *   input is a small typed model, so the signature is that model's own data.
 * - The reference's `unstable_headerSubtitle`, `unstable_headerToolbarItems`,
 *   `unstable_headerCenterItems` and `unstable_navigationItemStyle` come from its patches to the
 *   native side of `react-native-screens`. Vivid's pinned packages are unpatched and a native
 *   change cannot ship over the air, so none of them is used. A line under the title is drawn by
 *   `StandingBar` in the bar's own title slot (`headerTitle`), which the unpatched stack has.
 */

/** The names of the system's symbols, as the installed stack types a bar button's icon. */
type SymbolName = Extract<
  NonNullable<NativeStackHeaderItemButton['icon']>,
  { type: 'sfSymbol' }
>['name']

/**
 * One action in the bar. It names its picture twice because the two platforms draw it from
 * different sets: iOS from the system's symbols, inside its own bar button, and Android from the
 * app's icons.
 */
export interface BarAction {
  readonly symbol: SymbolName
  readonly icon: LucideIcon
  /** What a screen reader says; the picture says nothing to it. */
  readonly label: string
  readonly disabled: boolean
  readonly onPress: () => void
}

/** A bar with no actions. One value, so a screen that has none does not make a new list each render. */
export const NO_ACTIONS: ReadonlyArray<BarAction> = []

/** Presses the action in a place, whichever handler is the newest there. */
type PressAt = (place: number) => void

/** iOS: each action as the system's own bar button. */
const barItems = (actions: ReadonlyArray<BarAction>, press: PressAt): NativeStackHeaderItem[] =>
  actions.map((action, place) => ({
    type: 'button',
    // The symbol is the whole button; the name is for assistive technology only.
    label: '',
    accessibilityLabel: action.label,
    icon: { type: 'sfSymbol', name: action.symbol },
    disabled: action.disabled,
    variant: 'plain',
    // Each action on its own round of glass, not several in one capsule.
    sharesBackground: false,
    onPress: () => press(place),
  }))

/** Android: the same actions drawn by the app, at the end of the solid bar. */
function BarButtons({ actions, press }: { actions: ReadonlyArray<BarAction>; press: PressAt }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {actions.map((action, place) => (
        <IconButton
          key={action.label}
          icon={action.icon}
          label={action.label}
          disabled={action.disabled}
          onPress={() => press(place)}
        />
      ))}
    </View>
  )
}

/** The options that put a list of actions at the end of the bar, on either platform. */
const actionOptions = (
  actions: ReadonlyArray<BarAction>,
  press: PressAt,
): NativeStackNavigationOptions =>
  Platform.OS === 'ios'
    ? { unstable_headerRightItems: () => barItems(actions, press) }
    : {
        headerRight:
          actions.length === 0 ? undefined : () => <BarButtons actions={actions} press={press} />,
      }

/** What of an action decides how the bar looks. Its handler does not; `useBar` keeps that fresh. */
const shownOf = (actions: ReadonlyArray<BarAction>) =>
  actions.map((action) => [action.symbol, action.label, action.disabled])

/**
 * Applies a screen's bar. `signature` is everything the options are built from, as text: the
 * options are built and handed to the navigator only when it changes.
 */
function useBar(
  signature: string,
  actions: ReadonlyArray<BarAction>,
  build: (press: PressAt) => NativeStackNavigationOptions,
) {
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>()
  // The newest render's actions and options, for the bar to read. Kept after every commit, before
  // paint, so a press can never reach a handler from an older render. This effect is declared
  // first, so it has run by the time the one below reads what it kept.
  const latest = useRef({ actions, build })
  useLayoutEffect(() => {
    latest.current = { actions, build }
  })
  // Keyed by the signature alone: `build` is a new function every render, and equal options
  // must not be handed to the navigator again.
  useLayoutEffect(() => {
    navigation.setOptions(
      latest.current.build((place) => {
        const action = latest.current.actions[place]
        if (action !== undefined) action.onPress()
      }),
    )
  }, [navigation, signature])
}

/** A screen's bar: the system's own title, and its actions. */
export function Bar({ title, actions }: { title: string; actions: ReadonlyArray<BarAction> }) {
  useBar(JSON.stringify([title, shownOf(actions)]), actions, (press) => ({
    title,
    ...actionOptions(actions, press),
  }))
  return null
}

/** The line under a title: how something is doing right now, in words and in that state's ink. */
export interface Standing {
  readonly words: string
  readonly tone: Tone
}

interface StandingProps {
  readonly title: string
  readonly standing: Standing
  /** Vivid's face before the title, on the screens where Vivid is at work. */
  readonly mood: Option.Option<FaceMood>
  /** Who else is looking, after the title. */
  readonly present: ReadonlyArray<PersonSummary>
}

/**
 * A bar whose title has a live line under it: a Thread saying that Vivid is working or waiting,
 * the Computer saying how it is. The title, the line, Vivid's face and who else is here are one
 * element in the bar's title slot; the way back and the actions stay the system's.
 *
 * The reference says this line with `unstable_headerSubtitle`, which needs its native patch
 * (see the note at the top of this file). `headerTitle` as an element is what the unpatched
 * stack offers; the cost, by its own documentation, is that the system does not animate a custom
 * title during a push.
 */
export function StandingBar({
  actions,
  ...shown
}: StandingProps & { actions: ReadonlyArray<BarAction> }) {
  const mood = Option.getOrUndefined(shown.mood)
  const people = shown.present.map((person) => [person.id, person.name, person.image])
  useBar(
    JSON.stringify([shown.title, shown.standing, mood, people, shownOf(actions)]),
    actions,
    (press) => ({
      // The words too, for the system: the back menu of the next screen names this one by them.
      title: shown.title,
      headerTitle: () => <StandingTitle {...shown} actions={actions.length} />,
      ...actionOptions(actions, press),
    }),
  )
  return null
}

/**
 * The room the bar's own controls take, which the title must leave them. UIKit centres a title
 * view and does not shrink one, so a long Thread title is given a width to truncate in: the
 * screen, less the way back and less each action. These are the bar's usual metrics (a 44-point
 * control, 16 from the edge, 8 between), not values read from the system.
 */
const BACK_ROOM = 16 + TARGET + 8
const actionsRoom = (count: number) => (count === 0 ? 16 : 16 + count * (TARGET + 8))

/** The title element `StandingBar` puts in the bar. The header role stays on the title's words. */
function StandingTitle({
  title,
  standing,
  mood,
  present,
  actions,
}: StandingProps & { actions: number }) {
  const { width } = useWindowDimensions()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        maxWidth: width - BACK_ROOM - actionsRoom(actions),
      }}
    >
      {Option.isSome(mood) && <Face size={28} mood={mood.value} />}
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        {/* 17 points, as the reference sets a Thread's title over glass
            (`ThreadRouteScreen.tsx`, `headerTitleStyle`). */}
        <Label accessibilityRole="header" numberOfLines={1} size="heading" style={{ fontSize: 17 }}>
          {title}
        </Label>
        {/* Said again to a screen reader when it changes: it is where a Thread says that Vivid
            has started working, or is now waiting for the Person. */}
        <Label
          accessibilityLiveRegion="polite"
          numberOfLines={1}
          size="caption"
          tone={standing.tone}
        >
          {standing.words}
        </Label>
      </View>
      {present.length > 0 && <Faces people={present} size={20} />}
    </View>
  )
}

/**
 * The bar's height as empty room, for a screen whose content is not an ordinary scroller.
 *
 * Under a glass bar UIKit insets a scroll view by itself (`contentInsetAdjustmentBehavior`), and
 * that is what every ordinary screen uses. A Thread's list is inverted, so the system's top inset
 * would land at the foot of the conversation; it and the Thread's outline take this room instead,
 * at their visual top. The height is the stack's own measurement, so it follows the device and
 * the text size. Where the bar is solid the content already starts below it and no room is made.
 */
export function BarRoom() {
  return GLASS_SUPPORTED ? <MeasuredRoom /> : null
}

function MeasuredRoom() {
  const height = useAnimatedHeaderHeight()
  return <Animated.View style={{ height }} />
}
