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
import type { LucideIcon } from 'lucide-react-native'
import { useLayoutEffect, useRef } from 'react'
import { Animated, Platform, View } from 'react-native'
import { openDrawer } from '../data/drawer'
import { Faces } from './Avatar'
import { Face } from './Face'
import { GLASS_SUPPORTED } from './Glass'
import { NO_SCROLL_EDGES, SCROLL_EDGES } from './stack'
import { IconButton, Label, Press, TARGET, type Tone } from './ui'

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
 * - Each item is set as the reference's `withNativeGlassHeaderItem` sets it
 *   (`src/features/layout/native-glass-header-items.ts`): `variant: 'plain'`,
 *   `sharesBackground: true`, `hidesSharedBackground: false`, and `glassEffect: false`. Its
 *   note: a bar button already gets the system's glass, and `glassEffect` makes
 *   react-native-screens draw a custom button, which shows as a second thin capsule.
 * - The line under a title is `unstable_headerSubtitle`, UIKit's own subtitle, set only where
 *   the bar is glass, as the reference does (`ThreadRouteScreen.tsx`).
 *
 * `unstable_headerSubtitle` and `glassEffect` exist through the two patches described in
 * `ui/stack.ts`, so they need a binary built with them (app version 0.2.0 and later).
 *
 * What differs, and why:
 * - The reference compares options by walking any object and reading function source. Here the
 *   input is a small typed model, so the signature is that model's own data.
 * - The reference's bottom toolbar (`unstable_headerToolbarItems`) is not used: no Vivid screen
 *   has actions that belong at the foot of the screen.
 * - The reference draws its own bar on Android, with the subtitle in it. Vivid keeps the
 *   platform's solid bar there and puts the title and its line in the bar's title slot.
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
    glassEffect: false,
    sharesBackground: true,
    hidesSharedBackground: false,
    onPress: () => press(place),
  }))

/** Who else is looking, as an item of its own before the actions: faces on no glass of their own. */
const presentItem = (present: ReadonlyArray<PersonSummary>): NativeStackHeaderItem[] =>
  present.length === 0
    ? []
    : [
        {
          type: 'custom',
          element: <Faces people={present} size={20} />,
          hidesSharedBackground: true,
        },
      ]

/** What stands at the end of a bar: who else is here, then what can be done. */
interface BarEnd {
  readonly present: ReadonlyArray<PersonSummary>
  readonly actions: ReadonlyArray<BarAction>
}

/** Android: the same faces and actions drawn by the app, at the end of the solid bar. */
function BarButtons({ present, actions, press }: BarEnd & { press: PressAt }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      {present.length > 0 && <Faces people={present} size={20} />}
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

/** The options that put faces and actions at the end of the bar, on either platform. */
const endOptions = (end: BarEnd, press: PressAt): NativeStackNavigationOptions =>
  Platform.OS === 'ios'
    ? {
        unstable_headerRightItems: () => [
          ...presentItem(end.present),
          ...barItems(end.actions, press),
        ],
      }
    : {
        headerRight:
          end.present.length + end.actions.length === 0
            ? undefined
            : () => <BarButtons {...end} press={press} />,
      }

/**
 * Vivid's mark at the start of the first screen's bar. Pressing it opens the menu (`ui/Drawer.tsx`).
 * It is the one face on that screen, so it also says how Vivid is: thinking while it is at work.
 *
 * On iOS it is a custom item of the system's bar, which on iOS 26 gives it the same round of
 * glass as every other bar button; the round the app used to draw for it (`Glass` in Home's own
 * top) is gone with the bar the app drew.
 */
function MenuMark({ mood }: { mood: FaceMood }) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel="Open menu"
      onPress={openDrawer}
      style={{ width: TARGET, height: TARGET, alignItems: 'center', justifyContent: 'center' }}
    >
      <Face size={28} mood={mood} />
    </Press>
  )
}

/**
 * The options that put Vivid's mark where a pushed screen has the way back. The first screen is
 * the root of the stack, so the system draws no way back there and the mark is alone at the start.
 */
const menuOptions = (mood: FaceMood): NativeStackNavigationOptions =>
  Platform.OS === 'ios'
    ? {
        unstable_headerLeftItems: () => [
          { type: 'custom', element: <MenuMark mood={mood} />, hidesSharedBackground: false },
        ],
      }
    : { headerLeft: () => <MenuMark mood={mood} /> }

/** Nobody else is here. One value, for the same reason as `NO_ACTIONS`. */
const NOBODY: ReadonlyArray<PersonSummary> = []

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
    ...PLAIN,
    ...endOptions({ present: NOBODY, actions }, press),
  }))
  return null
}

/**
 * The first screen's bar while nothing has been said: Vivid's mark, and no title, because the
 * greeting under it is what the screen says.
 */
export function MenuBar({ mood }: { mood: FaceMood }) {
  useBar(JSON.stringify(['menu', mood]), NO_ACTIONS, (press) => ({
    title: '',
    ...PLAIN,
    // The greeting's scroller is the right way up; a Thread on this same route turns the effect
    // off (`MenuStandingBar`), so it is named here to come back on.
    scrollEdgeEffects: GLASS_SUPPORTED ? SCROLL_EDGES : undefined,
    ...menuOptions(mood),
    ...endOptions({ present: NOBODY, actions: NO_ACTIONS }, press),
  }))
  return null
}

/** The line under a title: how something is doing right now, in words and in that state's ink. */
export interface Standing {
  readonly words: string
  readonly tone: Tone
}

/**
 * The line under the title, where each platform can say it.
 * - Glass (iOS 26): UIKit's own subtitle. It is the system's text, so it is in the system's ink;
 *   the state is in the words.
 * - Everywhere else (Android, and iOS without glass): the title and the line as one element in
 *   the solid bar's title slot, with the line in its state's ink. The reference shows no line on
 *   iOS without glass; Vivid does, because nothing else on a Thread says that Vivid is waiting
 *   for the Person or that someone is typing.
 *
 * Both fields are always named. `setOptions` merges into what the route already has, so a field
 * left out would keep whatever an earlier bar on the same route put there.
 */
const standingOptions = (title: string, standing: Standing): NativeStackNavigationOptions =>
  GLASS_SUPPORTED
    ? { headerTitle: undefined, unstable_headerSubtitle: standing.words }
    : {
        headerTitle: () => <StandingTitle title={title} standing={standing} />,
        unstable_headerSubtitle: undefined,
      }

/**
 * What a plain bar says about the fields only a `StandingBar` fills: nothing, explicitly. One
 * route can draw both (a Thread that turns out to be gone goes from its live bar to a plain one),
 * and `setOptions` merges, so without this the plain bar would keep the other's title element or
 * subtitle. The end of the bar needs no clearing: every bar sets it.
 */
const PLAIN = { headerTitle: undefined, unstable_headerSubtitle: undefined } as const

/**
 * A bar whose title has a live line under it: a Thread saying that Vivid is working or waiting,
 * the Computer saying how it is. `present` is who else is looking at the same thing.
 *
 * Vivid's face is not in this bar. The reference has no slot for a picture beside the title of a
 * screen that also has the system's way back (its centre items replace the title, its left items
 * replace or follow the back button), and a Thread already shows Vivid's face at work where its
 * words are. So the bar says the state in words and the conversation shows the face.
 */
export function StandingBar({
  title,
  standing,
  present,
  actions,
}: BarEnd & { title: string; standing: Standing }) {
  const people = present.map((person) => [person.id, person.name, person.image])
  useBar(JSON.stringify([title, standing, people, shownOf(actions)]), actions, (press) => ({
    title,
    ...standingOptions(title, standing),
    ...endOptions({ present, actions }, press),
  }))
  return null
}

/**
 * A Thread's bar on the first screen: a `StandingBar` that starts with Vivid's mark, since the
 * Thread is in the first screen's place and there is nothing to go back to.
 */
export function MenuStandingBar({
  mood,
  title,
  standing,
  present,
  actions,
}: BarEnd & { mood: FaceMood; title: string; standing: Standing }) {
  const people = present.map((person) => [person.id, person.name, person.image])
  const signature = JSON.stringify(['menu', mood, title, standing, people, shownOf(actions)])
  useBar(signature, actions, (press) => ({
    title,
    ...standingOptions(title, standing),
    // A Thread's list is inverted, and the system's edge effect frosts all of an inverted list
    // (`NO_SCROLL_EDGES`).
    scrollEdgeEffects: GLASS_SUPPORTED ? NO_SCROLL_EDGES : undefined,
    ...menuOptions(mood),
    ...endOptions({ present, actions }, press),
  }))
  return null
}

/** The title element of a solid bar. The header role stays on the title's words. */
function StandingTitle({ title, standing }: { title: string; standing: Standing }) {
  return (
    <View>
      <Label accessibilityRole="header" numberOfLines={1} size="heading">
        {title}
      </Label>
      {/* Said again to a screen reader when it changes: it is where a Thread says that Vivid
          has started working, or is now waiting for the Person. */}
      <Label accessibilityLiveRegion="polite" numberOfLines={1} size="caption" tone={standing.tone}>
        {standing.words}
      </Label>
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
