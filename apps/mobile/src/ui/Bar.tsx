import type { PersonSummary } from '@vivid/contracts'
import { useIsFocused, useNavigation, type ParamListBase } from '@react-navigation/native'
import {
  useAnimatedHeaderHeight,
  type NativeStackHeaderItem,
  type NativeStackHeaderItemButton,
  type NativeStackNavigationOptions,
  type NativeStackNavigationProp,
} from '@react-navigation/native-stack'
import { Menu as MenuLines, Phone, type LucideIcon } from 'lucide-react-native'
import { useLayoutEffect, useRef, useState } from 'react'
import { Animated, Image, Platform, View } from 'react-native'
import { openDrawer } from '../data/drawer'
import { menuMark, useMenuMark } from '../data/mark'
import type { Stand } from '../data/stand'
import { useAppearance } from '../data/vivid'
import { useTheme } from '../theme'
import { Faces } from './Avatar'
import { GLASS_SUPPORTED } from './Glass'
import { presence, type Told } from './Presence'
import { NO_SCROLL_EDGES, SCROLL_EDGES } from './stack'
import { IconButton, Label, Press, radius, TARGET, type Tone } from './ui'

/**
 * What a screen puts in the system's navigation bar: its title and at most a couple of actions.
 *
 * The bar is the platform's own (`GLASS_HEADER` in `ui/stack.ts`). On iOS every action is a real
 * `UIBarButtonItem`, so on iOS 26 the system draws it, and the way back, as round liquid glass;
 * nothing here draws a button. A screen says what it wants by rendering `Bar`, `StandingBar` or
 * `VividBar`, which draw nothing themselves. A Thread also renders `VividAtTop`, which says how
 * Vivid's avatar stands; that floats over the stack where the bar's title would be
 * (`ui/Presence.tsx`).
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

/** What a screen reader says for the way to the menu. */
const MENU_LABEL = 'Open menu'

/** The mark's own size: the 22 points the image is drawn at (`assets/menu.png`). */
const MENU_MARK = 22

/**
 * iOS: the way to the menu as the system's own bar button. Its picture is the app's own mark
 * once that is known to load (`own`, `data/mark.ts`), and the system's three-line symbol until
 * then, so the button is never blank.
 */
const menuItem = (own: boolean): NativeStackHeaderItem => ({
  type: 'button',
  // The picture is the whole button; the name is for assistive technology only.
  label: '',
  accessibilityLabel: MENU_LABEL,
  // The image is tinted, so the system draws it in the bar's own ink as it does a symbol.
  icon: own
    ? { type: 'image', source: menuMark, tinted: true }
    : { type: 'sfSymbol', name: 'line.3.horizontal' },
  variant: 'plain',
  glassEffect: false,
  sharesBackground: true,
  hidesSharedBackground: false,
  onPress: openDrawer,
})

/** Android: the same mark, or the three lines until it loads, in a button the app draws. */
function MenuButton() {
  const { colors: c } = useTheme()
  const own = useMenuMark()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={MENU_LABEL}
      onPress={openDrawer}
      style={({ pressed }) => ({
        width: TARGET,
        height: TARGET,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.control,
        backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
      })}
    >
      {own ? (
        <Image
          source={menuMark}
          // The mark is black on clear; the tint draws it in the bar's ink.
          style={{ width: MENU_MARK, height: MENU_MARK, tintColor: c['ink-2'] }}
        />
      ) : (
        <MenuLines pointerEvents="none" size={21} strokeWidth={1.7} color={c['ink-2']} />
      )}
    </Press>
  )
}

/**
 * The options that put the way to the menu where a pushed screen has the way back. The first
 * screen is the root of the stack, so the system draws no way back there and this button is
 * alone at the start.
 *
 * It is a bar button of its own (the reference's "Show thread sidebar" button,
 * `src/features/layout/workspace-sidebar-toolbar.tsx`), so on iOS 26 the system draws it as round
 * glass like every other bar button. Its picture is the mark the owner pointed at, the Claude
 * iPhone app's (6 October 2026): three lines from one edge, the last about half as long. The
 * reference's is the system's sidebar symbol, a window with a pane, which he called "the pc
 * version" on a phone, and the system has no symbol for this one, so it is an image of ours
 * (`assets/menu.png`, drawn at 22 points for each screen density). The installed
 * react-native-screens loads a bar button's image with its density and draws it as a template
 * (`ios/helpers/image/RNSImageLoadingHelper.mm`), so it arrives in an update like any other
 * asset and needs no new binary. It is used only once it is known to load (`data/mark.ts`).
 *
 * Vivid's face used to be the button; the owner asked for a menu icon here and Vivid in the
 * centre (5 October 2026). `unstable_headerLeftItems` is iOS's, so Android gets the same mark in
 * a button drawn by the app in its solid bar.
 */
const menuOptions = (own: boolean): NativeStackNavigationOptions =>
  Platform.OS === 'ios'
    ? { unstable_headerLeftItems: () => [menuItem(own)] }
    : { headerLeft: () => <MenuButton /> }

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
 * The way to call Vivid, which ends the first screen's bar.
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
 * Tells the avatar over the stack how Vivid stands on this screen (`presence`,
 * `ui/Presence.tsx`), for as long as this screen is the one in front.
 *
 * It is said in a layout effect, before paint, for the reason a screen's bar options are
 * (`useBar`): what a screen says cannot be handed up while it renders, and said any later the
 * avatar would be seen for a frame as the last screen left it. It is said again only when what
 * it would show has changed. A screen that is covered, or gone, takes back only what it said
 * itself, so it can never clear what the screen now in front has already said.
 */
function useTelling(said: Told) {
  const focused = useIsFocused()
  // This screen's own token. State, not a ref: it is read while rendering the effects below.
  const [owner] = useState(() => Symbol('screen'))
  const latest = useRef(said)
  useLayoutEffect(() => {
    latest.current = said
  })
  const signature = JSON.stringify(said.stand)
  useLayoutEffect(() => {
    if (focused) presence.say(owner, latest.current)
    else presence.leave(owner)
  }, [focused, owner, signature])
  useLayoutEffect(() => () => presence.leave(owner), [owner])
}

/**
 * Vivid at the top centre of this screen, standing as `stand` says, for as long as this is
 * rendered and the screen is in front. A Thread with words in it renders this; a page with no
 * conversation yet has Vivid's avatar in its own middle instead and does not. It draws nothing
 * itself: the avatar is the one over the stack (`Presence`).
 */
export function VividAtTop({ stand }: { stand: Stand }) {
  useTelling({ stand })
  return null
}

/**
 * The first screen's bar, whether it shows the greeting or a Thread: the way to the menu first,
 * nothing in the middle, and at the end who else is here, what can be done, and the way to call
 * Vivid.
 *
 * The middle is Vivid's, and Vivid is not in the bar. The title is left empty and, in a Thread,
 * Vivid's avatar floats over the whole stack in its place (`VividAtTop`, `Presence`), where it
 * can be pressed and change shape on the UI thread. A Thread's title is not in its bar either:
 * the owner asked for Vivid in the centre, and the title is where the Person chose the Thread,
 * its row in the menu.
 *
 * `inverted` says the screen's scroller is a Thread's upside-down list, which the system's edge
 * effect frosts whole (`NO_SCROLL_EDGES`); the greeting's scroller is the right way up and keeps
 * the effect. Both are named every time, because the two share one route and `setOptions` merges.
 */
export function VividBar({ inverted, present, actions }: BarEnd & { inverted: boolean }) {
  const vivid = useAppearance()
  const end: BarEnd = { present, actions: [...actions, callAction(vivid.name)] }
  const people = present.map((person) => [person.id, person.name, person.image])
  // Part of what the bar looks like: the options are applied again when the mark is known to load.
  const own = useMenuMark()
  useBar(
    JSON.stringify(['vivid', inverted, own, people, shownOf(end.actions)]),
    end.actions,
    (press) => ({
      title: '',
      ...PLAIN,
      scrollEdgeEffects: edgesFor(inverted),
      ...menuOptions(own),
      ...endOptions(end, press),
    }),
  )
  return null
}

/** The system's edge effect for the first screen's scroller, where the bar is glass. */
const edgesFor = (inverted: boolean): NativeStackNavigationOptions['scrollEdgeEffects'] => {
  if (!GLASS_SUPPORTED) return undefined
  return inverted ? NO_SCROLL_EDGES : SCROLL_EDGES
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
 * would land at the foot of the conversation; the Thread puts this room above its list and its
 * outline instead, so neither is ever behind the bar (`Transcript`, `screen/Chat.tsx`). The height is the stack's own measurement, so it follows the device and
 * the text size. Where the bar is solid the content already starts below it and no room is made.
 */
export function BarRoom() {
  return GLASS_SUPPORTED ? <MeasuredRoom /> : null
}

function MeasuredRoom() {
  const height = useAnimatedHeaderHeight()
  return <Animated.View style={{ height }} />
}
