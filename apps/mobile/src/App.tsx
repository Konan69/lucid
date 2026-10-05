import { RegistryContext } from '@effect/atom-react'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import { NavigationContainer } from '@react-navigation/native'
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from '@react-navigation/native-stack'
import { workspaceKey } from '@vivid/state'
import { useState } from 'react'
import { StatusBar, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useReducedMotion } from 'react-native-reanimated'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { door, patienceAtom, useDoor } from './data/door'
import { homeShown } from './data/fresh'
import { leadOf, reachOf, type Reach } from './data/lead'
import {
  Entry,
  entryAtom,
  LiveDataProvider,
  LiveState,
  useLive,
  useLiveData,
  type LiveData,
} from './data/live'
import { leaveAtom } from './data/signing'
import { Broken } from './screen/Broken'
import { Chat } from './screen/Chat'
import { Computer } from './screen/Computer'
import { Door } from './screen/Door'
import { Home } from './screen/Home'
import { Folder, Library } from './screen/Library'
import { Notifications } from './screen/Notifications'
import { Project, Projects } from './screen/Projects'
import { Routines } from './screen/Routines'
import { Settings } from './screen/Settings'
import { Side } from './screen/Side'
import { Memory } from './screen/settings/Memory'
import { Texting } from './screen/settings/Texting'
import { People } from './screen/settings/People'
import { ThemeProvider, useTheme } from './theme'
import { leadOptions } from './ui/Bar'
import { Presence } from './ui/Presence'
import { Recover } from './ui/Recover'
import { BESIDE, FRONT_HEADER, GLASS_HEADER, navigationTheme, pushAnimation } from './ui/stack'
import { Button, Face, GUTTER, Label } from './ui/ui'
import { MeProvider, useGo, type Routes } from './workspace'

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
    Opening: () => <Quiet mood="neutral" />,
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

/** Who is signed in is one live query; the shell is drawn only once it has answered. */
function Session() {
  const data = useLiveData()
  const me = useLive(data.live.me)
  return LiveState.$match(me, {
    Loading: () => <Connecting />,
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

/** Vivid alone on the palette's ground: what is shown while there is nothing truthful to say yet. */
function Quiet({ mood }: { mood: 'neutral' | 'thinking' }) {
  const { colors: c } = useTheme()
  return (
    <View
      accessibilityLabel="Opening Vivid"
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.screen,
      }}
    >
      <Face size={44} mood={mood} />
    </View>
  )
}

/** Ends this device's session, whether or not the server can be told. */
function useLeave() {
  const data = useLiveData()
  return () => door.set(leaveAtom, data.session)
}

/**
 * The socket is opening. It reconnects by itself for as long as it takes, so this never becomes
 * an error; but a Person who has waited a while is told what to check and given the way out.
 */
function Connecting() {
  const leave = useLeave()
  const { colors: c } = useTheme()
  const waited = AsyncResult.isSuccess(useDoor(patienceAtom))
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
        {waited ? 'Still trying to reach Vivid' : 'Connecting…'}
      </Label>
      {waited && (
        <>
          <Label size="label" tone="ink-2" style={{ textAlign: 'center', maxWidth: 300 }}>
            Check your connection. Vivid opens by itself as soon as it can.
          </Label>
          <View style={{ marginTop: 14 }}>
            <Button label="Sign out" onPress={leave} />
          </View>
        </>
      )}
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

/** A screen as the stack lists it: which one it is, and which screen it is. */
interface Placed {
  readonly key: string
  readonly name: string
}

/**
 * A Thread's own options, from where it stands in the stack (`data/lead.ts`). Beside Home it has
 * Home's bar, led by the way to the drawer, and it fades in; opened from anywhere else it is
 * under that place, led by the way back, and it is pushed like any other screen.
 */
const threadOptions = (
  routes: ReadonlyArray<Placed>,
  key: string,
  still: boolean,
): NativeStackNavigationOptions => {
  const lead = leadOf(
    routes,
    routes.findIndex((route) => route.key === key),
  )
  const arrival = lead === 'drawer' ? BESIDE : { animation: pushAnimation(still) }
  return { ...FRONT_HEADER, ...leadOptions(lead), ...arrival }
}

/**
 * Vivid's capsule over the stack (`ui/Presence.tsx`), and where the places in its menu lead. It
 * is outside every screen, so `useGo` here is the stack's own container: it goes to places, and
 * the screen in front is what they are pushed over.
 */
function Vivid() {
  const go = useGo()
  return <Presence onGo={(place) => go.navigate(place)} />
}

/**
 * The signed-in app: one native stack, with the drawer around it (`screen/Side.tsx`). Pushing,
 * popping and the back swipe are the platform's own; nothing here animates a screen. The bar is
 * the platform's too (`GLASS_HEADER`): its way back and its buttons are the system's, liquid glass
 * on iOS 26, with each screen's content scrolling under it. A screen that has actions or a live
 * title says so itself (`ui/Bar.tsx`); one whose bar is only its name has it here.
 *
 * Home and a Thread are the two screens a Person meets Vivid on, and they share one bar
 * (`FRONT_HEADER`): the way to the drawer first, Vivid's capsule in the middle (one capsule,
 * drawn over the stack: `Vivid` below), and the way to call Vivid at the end.
 *
 * Routes are flat on this one stack, never a nested navigator: one navigation controller is what
 * lets the platform carry a bar from one screen to the next (T3 Code mobile `src/Stack.tsx`, the
 * note beside `THREAD_LINKING_PREFIX`). How one screen replaces another is `pushAnimation`.
 */
function Shell() {
  const { colors: c, dark } = useTheme()
  const still = useReducedMotion()
  // Where a drag may open the drawer, for the screen now in front. The stack starts on Home, and
  // says so each time the screen in front changes.
  const [reach, setReach] = useState<Reach>('anywhere')
  return (
    <NavigationContainer
      theme={navigationTheme(c, dark)}
      onStateChange={(state) => {
        if (state !== undefined) setReach(reachOf(state.routes, state.index))
      }}
    >
      <Side reach={reach}>
        <Stack.Navigator
          screenOptions={{
            ...GLASS_HEADER,
            // The bar's glyphs are ink, as the app's own controls are; the navigation theme's
            // `primary` would paint the way back in the accent.
            headerTintColor: c.foreground,
            contentStyle: { backgroundColor: c.screen },
            animation: pushAnimation(still),
          }}
        >
          <Stack.Screen
            name="Home"
            component={Home}
            options={{ ...FRONT_HEADER, ...leadOptions('drawer') }}
            // Home is back in view once whatever covered it has finished leaving, which is when
            // a new Thread asked for from the drawer can take the keyboard (`data/fresh.ts`).
            listeners={{
              transitionEnd: (event) => {
                if (!event.data.closing) homeShown()
              },
            }}
          />
          <Stack.Screen
            name="Chat"
            component={Chat}
            options={({ navigation, route }) =>
              threadOptions(navigation.getState().routes, route.key, still)
            }
          />
          {/* Screens that render a `Bar` start with an empty title, so the route's name is never
              what the bar says before the screen has spoken. */}
          <Stack.Screen name="Computer" component={Computer} options={{ title: '' }} />
          <Stack.Screen name="Routines" component={Routines} options={{ title: '' }} />
          <Stack.Screen name="Library" component={Library} options={{ title: '' }} />
          <Stack.Screen name="Folder" component={Folder} options={{ title: '' }} />
          <Stack.Screen name="Projects" component={Projects} options={{ title: '' }} />
          {/* The bar is only the way back: the Project's name is the page's own first line. */}
          <Stack.Screen name="Project" component={Project} options={{ title: '' }} />
          <Stack.Screen name="Settings" component={Settings} options={{ title: 'Settings' }} />
          <Stack.Screen name="People" component={People} options={{ title: '' }} />
          <Stack.Screen name="Memory" component={Memory} options={{ title: 'What Vivid knows' }} />
          <Stack.Screen name="Texting" component={Texting} options={{ title: 'Text Vivid' }} />
          <Stack.Screen name="Notifications" component={Notifications} options={{ title: '' }} />
        </Stack.Navigator>
        <Vivid />
      </Side>
    </NavigationContainer>
  )
}
