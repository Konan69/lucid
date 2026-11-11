import { VividRpcClient } from '@vivid/client-runtime'
import { RegistryContext } from '@effect/atom-react'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import {
  createNavigationContainerRef,
  NavigationContainer,
  StackActions,
  type NavigationContainerRefWithCurrent,
} from '@react-navigation/native'
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from '@react-navigation/native-stack'
import { NotificationOpens } from '@vivid/contracts'
import { workspaceKey } from '@vivid/state'
import { Effect, Option } from 'effect'
import { useState, useSyncExternalStore, type ComponentProps } from 'react'
import { AppState, StatusBar, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { door, patienceAtom, useDoor } from './data/door'
import { navigationTelemetry } from './data/telemetry'
import { Front, makeFront, type FrontStore } from './data/front'
import {
  Entry,
  entryAtom,
  LiveDataProvider,
  LiveState,
  useLive,
  useLiveData,
  type LiveData,
} from './data/live'
import { forgotten, pageOf, type Place } from './data/place'
import { heardReadAtom } from './data/hearing'
import { listenForLinks } from './data/links'
import { listenForPresses } from './data/notifying'
import { keepPlace, placeIn, placesReadAtom } from './data/placed'
import { leaveAtom } from './data/signing'
import { Broken } from './screen/Broken'
import { arrive } from './data/computer'
import { Computer } from './screen/Computer'
import { Door } from './screen/Door'
import { Home } from './screen/Home'
import { Account, NameAccount } from './screen/integration/Account'
import { FlowProvider } from './screen/integration/Provider'
import { Panel } from './screen/home/Panel'
import { Folder, Library } from './screen/Library'
import { Feed } from './screen/Feed'
import { Notifications } from './screen/Notifications'
import { Project, Projects } from './screen/Projects'
import { Settings } from './screen/Settings'
import { Integrations } from './screen/settings/Integrations'
import { Add } from './screen/chat/Add'
import { Memory } from './screen/settings/Memory'
import { Texting } from './screen/settings/Texting'
import { People } from './screen/settings/People'
import { ThemeProvider, useTheme } from './theme'
import { useMenuMark } from './data/mark'
import { menuOptions } from './ui/Bar'
import { Drawer } from './ui/Drawer'
import { IN_THREAD, ON_GREETING, Presence } from './ui/Presence'
import { Recover } from './ui/Recover'
import { FITTED_SHEET, GLASS_HEADER, navigationTheme, SCREEN_CHANGE } from './ui/stack'
import { Button, Face, GUTTER, Label } from './ui/ui'
import {
  FrontProvider,
  MeProvider,
  openPage,
  standsForHome,
  useFront,
  useMe,
  useShowing,
  type Routes,
} from './workspace'

const Stack = createNativeStackNavigator<Routes>()

/**
 * The app. Three facts decide what is on screen, each read from one atom and none copied into
 * component state: whether this device has a session (`entryAtom`), whether that session's
 * server has answered who the Person is (`live.me`), and then wherever the stack says they are.
 */
export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Bar />
          {/* The last line of defence: whatever fails to draw, there is still a screen with a way
              on. It sits inside the palette, which the fallback is painted in, and outside the
              session, so trying again builds the signed-in tree afresh from its atoms. */}
          <Recover from="app" fallback={<Broken />}>
            <Root />
          </Recover>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

/** The status bar's ink follows the palette, on every screen including the door. */
function Bar() {
  const { dark } = useTheme()
  return <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
}

function Root() {
  const entry = useDoor(entryAtom)
  return Entry.$match(entry, {
    Opening: () => <Ground />,
    Door: ({ session }) => <Door session={session} />,
    In: ({ data }) => <SignedIn data={data} />,
  })
}

/**
 * Everything drawn for one session, inside that session's own Atom registry. The registry is
 * the session's, so signing out disposes every query a screen was reading and a different
 * Person's data can never be drawn from a warm cache.
 */
function SignedIn({ data }: { data: LiveData }) {
  return (
    <RegistryContext.Provider value={data.registry}>
      <LiveDataProvider value={data}>
        <Session />
      </LiveDataProvider>
    </RegistryContext.Provider>
  )
}

/**
 * Who is signed in is one live query; the shell is drawn only once it has answered, and once the
 * phone has read where this Person was (`data/place.ts`) and what their recent Threads last
 * said (`data/heard.ts`), so the shell opens there, with its words, and not at the greeting or
 * a Thread's outline first.
 *
 * A phone that has been used before answers both from what it kept (`data/snapshot.ts`), read
 * at once as the app starts (`data/storage.ts` `read`), so the first screen it draws is the shell
 * itself. The empty screen (`Ground`) is drawn only where the store could not be read at once,
 * and never a word about connecting. The words come only for a phone that kept
 * nothing and still has no answer after a while (`Unreached`).
 */
function Session() {
  // Both files are read at once as the app starts; the shell waits for the two answers.
  const placed = useDoor(placesReadAtom)
  const heard = useDoor(heardReadAtom)
  return placed && heard ? <Placed /> : <Ground />
}

/** The session once the phone knows where its Person was: the shell, as soon as `me` answers. */
function Placed() {
  const data = useLiveData()
  const me = useLive(data.live.me)
  return LiveState.$match(me, {
    Loading: () => <Unreached />,
    // A session the server no longer accepts is handled in the data (`live.ts`), which puts the
    // door back. What is left here is a server that knows the Person and still says no.
    Failed: ({ failure }) => <Stopped message={failure.message} />,
    Ready: ({ value }) => (
      <MeProvider value={value}>
        {/* One stack for each workspace. Screens stay mounted under whatever covers them, so a
            Library item sheet opened in one Company used to stay up, with that Company's item and
            its actions, after the Person moved to another (from the switcher, or from another
            device). Keying the stack by where they are working ends every screen, sheet, editor
            and half-finished action of the old workspace and starts the new one at Home. */}
        <Shell key={workspaceKey(value.workspace)} />
      </MeProvider>
    ),
  })
}

/**
 * The palette's ground and nothing on it: what is drawn for the few milliseconds in which the
 * phone reads what it kept. It used to be Vivid's face, then "Connecting…" under a thinking
 * face: two loading screens in a row on every launch, for a wait too short to read either. The
 * ground is the colour the launch screen already is, so the app appears to open straight into
 * itself.
 */
function Ground() {
  const { colors: c } = useTheme()
  return <View accessibilityLabel="Opening Vivid" style={{ flex: 1, backgroundColor: c.screen }} />
}

/** Ends this device's session, whether or not the server can be told. */
function useLeave() {
  const data = useLiveData()
  return () => door.set(leaveAtom, data.session)
}

/**
 * The server has not said who is signed in, and the phone kept nothing to start from: a first
 * launch after signing in, or one after what was kept ran out. The socket reconnects by itself
 * for as long as it takes, so this never becomes an error and for a while it says nothing at all
 * (`Ground`); a Person who has waited is told what to check and given the way out. A phone with
 * something kept never comes here.
 */
function Unreached() {
  const leave = useLeave()
  const { colors: c } = useTheme()
  const waited = AsyncResult.isSuccess(useDoor(patienceAtom))
  if (!waited) return <Ground />
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingHorizontal: GUTTER + 12,
        backgroundColor: c.screen,
      }}
    >
      <Face size={44} mood="thinking" />
      <Label size="headline" style={{ marginTop: 8, textAlign: 'center' }}>
        Still trying to reach Vivid
      </Label>
      <Label size="label" tone="ink-2" style={{ textAlign: 'center', maxWidth: 300 }}>
        Check your connection. Vivid opens by itself as soon as it can.
      </Label>
      <View style={{ marginTop: 14 }}>
        <Button label="Sign out" onPress={leave} />
      </View>
    </View>
  )
}

/** The server answered and will not show this Person anything. Its own sentence, and the way out. */
function Stopped({ message }: { message: string }) {
  const leave = useLeave()
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingHorizontal: GUTTER + 12,
        backgroundColor: c.screen,
      }}
    >
      <Label size="headline" style={{ textAlign: 'center' }}>
        Vivid cannot open this account
      </Label>
      <Label size="label" tone="ink-2" style={{ textAlign: 'center', maxWidth: 300 }}>
        {message}
      </Label>
      <View style={{ marginTop: 14 }}>
        <Button label="Sign out" onPress={leave} />
      </View>
    </View>
  )
}

/**
 * The pages open over Home, in order, up to the first that cannot be drawn again from its name
 * and what it was opened with (`Page` in `data/place.ts`): a bottom sheet is a step in something
 * the Person was doing, so what is kept ends at the page it was opened over.
 */
const pagesOf = (
  routes: ReadonlyArray<{ readonly name: string; readonly params?: object }>,
): Place['pages'] => {
  const pages: Array<Place['pages'][number]> = []
  // The first route is Home itself, which is always there.
  for (const route of routes.slice(1)) {
    const page = pageOf({ name: route.name, params: route.params })
    if (Option.isNone(page)) break
    pages.push(page.value)
  }
  return pages
}

/** What the stack hands its `layout`: its screens, where it stands, and its navigation. */
type StackLayout = Parameters<NonNullable<ComponentProps<typeof Stack.Navigator>['layout']>>[0]

/**
 * The stack with the menu over it. The menu can be dragged open while Home, the first route, is
 * the screen in front, or a page the drawer opened in Home's place (`DRAWER_PAGES`): over any
 * other screen the same drag is the system's way back.
 *
 * A bottom sheet is a route too (`FITTED_SHEET`). On iOS the system presents it over the whole
 * window, this layout included. On Android it is a view inside the stack, so what is drawn here
 * after the stack is drawn over it, and neither thing drawn here is: the menu's panel and scrim
 * are off the glass and take no touch while it is closed, and it cannot be opened under a sheet
 * (a sheet is a route over the first, so `reachable` is false and its drag is off); the avatar
 * is there only while a Thread says so, and a Thread says so only while its screen has the
 * focus (`useTelling`, `ui/Presence.tsx`), which a sheet takes.
 */
const underMenu = ({ children, state, navigation }: StackLayout) => (
  <Drawer
    reachable={state.index === 0 || standsForHome(state.routes[state.index].name, state.index)}
    panel={<Panel go={navigation} stack={state} />}
  >
    {children}
    <Vivid go={navigation} />
  </Drawer>
)

/**
 * Vivid's avatar over the stack (`ui/Presence.tsx`), and where the rows of its menu lead. It is
 * drawn here, after the stack and inside the menu's page, so it is over the system's bar, where
 * it can be pressed, and under the open menu. It is there only while a Thread with words in it
 * is in front; a page with no conversation has the avatar in its own middle.
 *
 * A new Thread is offered only while a Thread is in front: on the greeting the Person is already
 * starting one. The other rows are Vivid's own places, pushed over whatever is in front.
 */
function Vivid({ go }: { go: StackLayout['navigation'] }) {
  const front = useFront()
  const thread = Front.$is('Thread')(useShowing())
  const data = useLiveData()
  return (
    <Presence
      menu={{
        places: thread ? IN_THREAD : ON_GREETING,
        onGo: (place) => {
          if (place === 'Fresh') return front.fresh()
          if (place === 'Computer') arrive(data)
          go.navigate(place)
        },
      }}
    />
  )
}

/** A store that holds nothing; `useAfreshOnReturn` listens through it and reads no value. */
const NOTHING = () => 0

/**
 * Opens where a pressed notification opens (`NotificationOpens`, `data/notifying.ts`): its Thread
 * in Home's place, or the Feed or Notifications in front. The listener is the store's
 * subscription, so it goes with the shell, as `useAfreshOnReturn` listens: a shell left behind by
 * a change of workspace cannot move the new one.
 */
function usePressedNotifications(
  front: FrontStore,
  navigation: NavigationContainerRefWithCurrent<Routes>,
) {
  const data = useLiveData()
  /** Puts a page in front. The stack as `keep` reads it: before there is one there is nothing to put it on. */
  const show = (name: 'Feed' | 'Notifications') => {
    if (!navigation.isReady()) return
    Option.map(Option.fromUndefinedOr(navigation.getRootState()), (stack) =>
      navigation.dispatch(openPage(stack, { name })),
    )
  }
  /** Opens where a notification press or a `vivid://` link points (`data/links.ts`). */
  const open = NotificationOpens.match({
    Thread: ({ threadId }) => {
      front.open(threadId, false)
      if (navigation.isReady()) navigation.dispatch(StackActions.popToTop())
    },
    Feed: () => show('Feed'),
    Notifications: () => show('Notifications'),
  })
  const [listen] = useState(() => () => {
    const stopLinks = listenForLinks(open)
    const stopPresses = listenForPresses(open, ({ threadId, text, key }) => {
      void data.run(
        Effect.gen(function* () {
          const client = yield* VividRpcClient
          return yield* client.SendToThread({ threadId, text, key, pictures: [] })
        }),
      )
    })
    return () => {
      stopLinks()
      stopPresses()
    }
  })
  useSyncExternalStore(listen, NOTHING, NOTHING)
}

/**
 * Starts afresh when the Person comes back to an app that was put away for longer than a place is
 * kept (`KEPT_FOR`, `data/place.ts`): Home shows the greeting and nothing is open over it. A
 * phone that ended the app meanwhile is answered by what is kept instead (`placeIn`); this is the
 * app that stayed in memory, which would otherwise still show the last Thread hours later.
 *
 * The listener is the store's subscription, so it goes with the shell and a shell left behind by a
 * change of workspace cannot touch the new one, as `useArrival` in `screen/Home.tsx` listens.
 * Only `background` counts as away: `inactive` is a pulled-down Control Centre or a call banner.
 */
function useAfreshOnReturn(leave: () => void, afresh: () => void) {
  const [listen] = useState(() => () => {
    let left = Option.none<number>()
    const heard = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        left = Option.some(Date.now())
        leave()
        return
      }
      if (state !== 'active') return
      if (Option.exists(left, (at) => forgotten(at, Date.now()))) afresh()
      left = Option.none()
    })
    return () => heard.remove()
  })
  useSyncExternalStore(listen, NOTHING, NOTHING)
}

/**
 * What a drawer page standing in Home's place changes in its route's options: no way back, so
 * neither the bar's button nor the edge swipe can uncover the Thread Home holds, and the way to the
 * menu where the way back was, as Home has it. The rightward drag is then the drawer's
 * (`underMenu`). Android's back button still returns to Home, the app's start.
 */
const drawerPage = (stands: boolean, own: boolean): NativeStackNavigationOptions =>
  stands ? { gestureEnabled: false, headerBackVisible: false, ...menuOptions(own) } : {}

/**
 * The signed-in app: one native stack, with the menu over it.
 *
 * The first screen is Home, and a Thread is shown in Home's own place (`data/front.ts`), so the
 * commonest change in the app, from the greeting to a conversation or from one Thread to another,
 * changes no screen at all. The other places are screens over Home; one replaces another by a
 * short cross-fade and nothing slides (`SCREEN_CHANGE`).
 *
 * The bar is the platform's (`GLASS_HEADER`): its way back and its buttons are the system's,
 * liquid glass on iOS 26, with each screen's content scrolling under it. A screen that has
 * actions or a live title says so itself (`ui/Bar.tsx`); one whose bar is only its name has it
 * here. Home's bar starts with the way to the menu and ends with the way to call Vivid; in a
 * Thread Vivid's avatar floats in the middle (one avatar, drawn over the stack: `Vivid` above).
 *
 * The menu is the navigator's `layout`, so it is drawn over the stack and its bar and is handed
 * the stack's state: it can be dragged open while Home, or a page it opened in Home's place
 * (`DRAWER_PAGES`), is the screen in front.
 *
 * Routes are flat on this one stack, never a nested navigator: one navigation controller is what
 * lets the platform carry a bar from one screen to the next (T3 Code mobile `src/Stack.tsx`, the
 * note beside `THREAD_LINKING_PREFIX`).
 *
 * The integration flow is held around the navigator (`FlowProvider`), once for the shell: the
 * Integrations page, the two bottom sheets and the card in a Thread all begin and finish an
 * account through it; a key is typed inside the card or account that asked for it.
 */
function Shell() {
  const { colors: c, dark } = useTheme()
  const data = useLiveData()
  const workspace = workspaceKey(useMe().workspace)
  const menuMark = useMenuMark()
  // Where the Person was in this workspace when the app was last open (`data/place.ts`), read
  // once as the shell is built: it is where the shell starts, not something it follows.
  const [start] = useState(() => placeIn(data.session.server, workspace))
  // This shell's navigator, for the flow that is held around it. One for each shell, as the
  // container is: a ref shared across workspaces would point at whichever mounted last.
  const [navigation] = useState(() => createNavigationContainerRef<Routes>())
  /**
   * Keeps where the Person now is: the Thread in front and the pages over Home. Before the stack
   * exists there is nothing to read from it and nothing is written, so what was kept stands.
   */
  const keep = (showing: Front) => {
    if (!navigation.isReady()) return
    const stack = Option.fromUndefinedOr(navigation.getRootState())
    if (Option.isNone(stack)) return
    keepPlace(data.session.server, workspace, {
      thread: Front.$is('Thread')(showing) ? Option.some(showing.id) : Option.none(),
      pages: pagesOf(stack.value.routes),
      at: Date.now(),
    })
  }
  // What Home shows belongs to this shell, which is built again for each workspace (`Session`).
  const [front] = useState(() => makeFront(start.thread))
  usePressedNotifications(front, navigation)
  useAfreshOnReturn(
    // Kept again as the app is put away, so the time it was last seen is the time it went.
    () => keep(front.showing()),
    () => {
      front.fresh()
      if (navigation.isReady()) navigation.dispatch(StackActions.popToTop())
    },
  )
  return (
    <FrontProvider value={front}>
      <FlowProvider>
        <NavigationContainer
          ref={navigation}
          theme={navigationTheme(c, dark)}
          // The pages that were open over Home, in order, with Home under them.
          initialState={{ routes: [{ name: 'Home' }, ...start.pages] }}
          // Kept each time the Thread in front changes, from the moment there is a stack to read
          // beside it. The store is this shell's own and goes with it, listener and all.
          onReady={() => {
            navigationTelemetry.registerNavigationContainer(navigation)
            front.subscribe(() => keep(front.showing()))
          }}
          // And each time the stack changes: a page opened, closed, or gone back from.
          onStateChange={() => keep(front.showing())}
        >
          <Stack.Navigator
            layout={underMenu}
            screenOptions={({ route, navigation: stack }) => ({
              ...GLASS_HEADER,
              ...SCREEN_CHANGE,
              // The bar's glyphs are ink, as the app's own controls are; the navigation theme's
              // `primary` would paint the way back in the accent.
              headerTintColor: c.foreground,
              contentStyle: { backgroundColor: c.screen },
              ...drawerPage(
                standsForHome(
                  route.name,
                  stack.getState().routes.findIndex((at) => at.key === route.key),
                ),
                menuMark,
              ),
            })}
          >
            {/* Screens that render a bar of their own start with an empty title, so the route's
              name is never what the bar says before the screen has spoken. */}
            <Stack.Screen name="Home" component={Home} options={{ title: '' }} />
            <Stack.Screen name="Computer" component={Computer} options={{ title: '' }} />
            <Stack.Screen name="Library" component={Library} options={{ title: '' }} />
            <Stack.Screen name="Feed" component={Feed} options={{ title: '' }} />
            <Stack.Screen name="Folder" component={Folder} options={{ title: '' }} />
            <Stack.Screen name="Projects" component={Projects} options={{ title: '' }} />
            {/* The bar is only the way back: the Project's name is the page's own first line. */}
            <Stack.Screen name="Project" component={Project} options={{ title: '' }} />
            <Stack.Screen name="Settings" component={Settings} options={{ title: 'Settings' }} />
            <Stack.Screen name="People" component={People} options={{ title: '' }} />
            <Stack.Screen
              name="Memory"
              component={Memory}
              options={{ title: 'What Vivid knows' }}
            />
            <Stack.Screen name="Texting" component={Texting} options={{ title: 'Text Vivid' }} />
            <Stack.Screen
              name="Integrations"
              component={Integrations}
              options={{ title: 'Integrations' }}
            />
            <Stack.Screen name="Notifications" component={Notifications} options={{ title: '' }} />
            {/* Bottom sheets as tall as what they hold; each undoes the stack's bar and cross-fade. */}
            <Stack.Screen name="Account" component={Account} options={FITTED_SHEET} />
            <Stack.Screen name="NameAccount" component={NameAccount} options={FITTED_SHEET} />
            <Stack.Screen name="Add" component={Add} options={FITTED_SHEET} />
          </Stack.Navigator>
        </NavigationContainer>
      </FlowProvider>
    </FrontProvider>
  )
}
