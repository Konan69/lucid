import type { PersonSummary } from '@vivid/contracts'
import { useIsFocused, useNavigation, type ParamListBase } from '@react-navigation/native'
import {
  useAnimatedHeaderHeight,
  type NativeStackHeaderItem,
  type NativeStackHeaderItemButton,
  type NativeStackNavigationOptions,
  type NativeStackNavigationProp,
} from '@react-navigation/native-stack'
import { PanelLeft, Phone, type LucideIcon } from 'lucide-react-native'
import { useLayoutEffect, useRef, useState } from 'react'
import { Animated, Platform, useWindowDimensions, View } from 'react-native'
import { openDrawer } from '../data/drawer'
import type { Lead } from '../data/lead'
import type { Stand } from '../data/stand'
import { useAppearance } from '../data/vivid'
import { Faces } from './Avatar'
import { GLASS_SUPPORTED } from './Glass'
import { fronting, type Front, type Origin } from './Presence'
import { IconButton, Label, TARGET, type Tone } from './ui'

/**
 * What a screen puts in the system's navigation bar: its title and at most a couple of actions.
 *
 * The bar is the platform's own (`GLASS_HEADER` in `ui/stack.ts`). On iOS every action is a real
 * `UIBarButtonItem`, so on iOS 26 the system draws it, and the way back, as round liquid glass;
 * nothing here draws a button. A screen says what it wants by rendering `Bar`, `StandingBar` or
 * `VividBar`, which draw nothing themselves. `VividBar` also says what Vivid's capsule shows,
 * which floats over the stack where the bar's title would be (`ui/Presence.tsx`).
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
 * - What leads a bar that has no way back is `unstable_headerLeftItems`, as the reference sets it
 *   on a Thread reached with nothing under it (`ThreadRouteScreen.tsx`, `compactHomeHeaderItems`).
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

/** Nobody else is here. One value, for the same reason as `NO_ACTIONS`. */
export const NOBODY: ReadonlyArray<PersonSummary> = []

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
 *   iOS without glass; Vivid does, because nothing else on the Computer's screen says in one
 *   line how the machine stands.
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
 * A bar whose title has a live line under it: the Computer saying how it is. `present` is who
 * else is looking at the same thing. A Thread used to have this bar too; it has `VividBar` now,
 * where the state is Vivid's own capsule in the middle and not a line under a title.
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

/** The title element of a solid bar. The header role stays on the title's words. */
function StandingTitle({ title, standing }: { title: string; standing: Standing }) {
  return (
    <View>
      <Label accessibilityRole="header" numberOfLines={1} size="heading">
        {title}
      </Label>
      {/* Said again to a screen reader when it changes: it is the screen's state in one line. */}
      <Label accessibilityLiveRegion="polite" numberOfLines={1} size="caption" tone={standing.tone}>
        {standing.words}
      </Label>
    </View>
  )
}

/** The way to the drawer, as the action it is in a bar. */
const DRAWER: BarAction = {
  symbol: 'sidebar.left',
  icon: PanelLeft,
  label: 'Open menu',
  disabled: false,
  onPress: openDrawer,
}

/**
 * What stands at the leading edge of a bar (`data/lead.ts`), as the options that put it there.
 *
 * These are a screen's own options in the stack, not something a mounted screen sets: what leads
 * a bar is decided by where the screen is in the stack, and has to be there in the first frame.
 *
 * - `drawer`: the system's sidebar symbol as a bar button of its own (the reference's "Show
 *   thread sidebar" button, `src/features/layout/workspace-sidebar-toolbar.tsx`), and no way
 *   back. The back swipe is off as well: the screen is beside Home, not over it, and a drag from
 *   that edge opens the drawer (`ui/Drawer.tsx`). `unstable_headerLeftItems` is iOS's, so Android
 *   gets the same button drawn by the app in its solid bar.
 * - `back`: the system's way back and its swipe, with nothing of the app's beside it.
 */
export const leadOptions = (lead: Lead): NativeStackNavigationOptions => {
  if (lead === 'back') {
    return {
      headerBackVisible: true,
      gestureEnabled: true,
      headerLeft: undefined,
      unstable_headerLeftItems: undefined,
    }
  }
  if (Platform.OS === 'ios') {
    return {
      headerBackVisible: false,
      gestureEnabled: false,
      unstable_headerLeftItems: () => barItems([DRAWER], () => openDrawer()),
    }
  }
  return {
    headerBackVisible: false,
    gestureEnabled: false,
    headerLeft: () => (
      <IconButton icon={DRAWER.icon} label={DRAWER.label} onPress={DRAWER.onPress} />
    ),
  }
}

/**
 * The room the bar keeps at each side of the capsule: the system's 16-point margin, one 44-point
 * button for each thing that stands there, and 12 between the buttons and the capsule. The
 * capsule is centred, so the busier side decides for both. The reference leaves room for its
 * bar's actions the same way (`src/features/home/WorkspaceConnectionTitle.tsx`, `maxWidth`).
 */
const roomBeside = (end: BarEnd): number => {
  const standing = end.actions.length + (end.present.length > 0 ? 1 : 0)
  return 16 + TARGET * Math.max(1, standing) + 12
}

/**
 * The least the capsule is ever allowed: its face and a few letters. A narrow window with a full
 * bar would otherwise work out to nothing, or less, and a width below zero is not a layout.
 */
const LEAST = 96

/** The widest the capsule may be in a window, between what stands at each end of its bar. */
const limitIn = (window: number, end: BarEnd): number =>
  Math.max(LEAST, window - 2 * roomBeside(end))

/**
 * The way to call Vivid, which ends the bar of Home and of a Thread.
 *
 * It does nothing yet. Vivid has no calls (`docs/22-one-product.md`, "Not in this build"), and
 * the owner asked for the button to stand in its place before they exist (5 October 2026: "do
 * nothing for now but it should be there"). It is drawn as any other bar button, not dimmed: it
 * is part of the bar's shape, and a screen reader is told plainly that it is not available. When
 * calls are built, this is the one place that starts them.
 */
const callAction = (name: string): BarAction => ({
  symbol: 'phone',
  icon: Phone,
  label: `Call ${name}. Not available yet`,
  disabled: false,
  onPress: () => undefined,
})

/**
 * Tells the capsule over the stack how Vivid stands on this screen (`fronting`, `ui/Presence.tsx`),
 * for as long as this screen is the one in front.
 *
 * It is said in a layout effect, before paint, for the reason a screen's bar options are
 * (`useBar`): what a screen says cannot be handed up while it renders, and said any later the
 * capsule would be seen for a frame as the last screen left it. It is said again only when what
 * it would show has changed. A screen that is covered, or gone, takes back only what it said
 * itself, so it can never clear what the screen now in front has already said.
 */
function useFronting(said: Front) {
  const focused = useIsFocused()
  // This screen's own token. State, not a ref: it is read while rendering the effects below.
  const [owner] = useState(() => Symbol('screen'))
  const latest = useRef(said)
  useLayoutEffect(() => {
    latest.current = said
  })
  const signature = JSON.stringify([said.stand, said.limit])
  const { button, sends } = said.origin
  useLayoutEffect(() => {
    if (focused) fronting.say(owner, latest.current)
    else fronting.leave(owner)
  }, [focused, owner, signature, button, sends])
  useLayoutEffect(() => () => fronting.leave(owner), [owner])
}

/**
 * The bar of the two screens a Person meets Vivid on, Home and a Thread: the way to the drawer
 * first (the screen's own option, `leadOptions`), Vivid's capsule in the middle, and at the end
 * who else is here, what can be done, and the way to call Vivid.
 *
 * The capsule is not in the bar. The bar's title is left empty and one capsule floats over the
 * whole stack in its place (`Presence`), where it can be pressed, change shape on the UI thread
 * and take the disc that rises from the composer. This says what that capsule should show while
 * the screen is in front, and draws nothing itself.
 *
 * `origin` is the composer on the same screen, where a send leaves from.
 */
export function VividBar({
  stand,
  origin,
  present,
  actions,
}: BarEnd & { stand: Stand; origin: Origin }) {
  const vivid = useAppearance()
  const end: BarEnd = { present, actions: [...actions, callAction(vivid.name)] }
  const limit = limitIn(useWindowDimensions().width, end)
  const people = present.map((person) => [person.id, person.name, person.image])
  useBar(JSON.stringify([people, shownOf(end.actions)]), end.actions, (press) => ({
    // Named, not left to the screen's own options: `setOptions` merges, and the same route can
    // have drawn a plain bar with a title first (a Thread that was not there, then one that is).
    title: '',
    headerTitle: undefined,
    unstable_headerSubtitle: undefined,
    ...endOptions(end, press),
  }))
  useFronting({ stand, origin, limit })
  return null
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
