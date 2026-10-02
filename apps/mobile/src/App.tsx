import { RegistryContext } from '@effect/atom-react'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { StatusBar, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { door, patienceAtom, useDoor } from './data/door'
import {
  Entry,
  entryAtom,
  LiveDataProvider,
  LiveState,
  useLive,
  useLiveData,
  type LiveData,
} from './data/live'
import { serverName } from './data/server'
import { leaveAtom } from './data/signing'
import { Broken } from './screen/Broken'
import { Chat } from './screen/Chat'
import { Door } from './screen/Door'
import { Home } from './screen/Home'
import { Folder, Library } from './screen/Library'
import { Project, Projects } from './screen/Projects'
import { Routines } from './screen/Routines'
import { Settings } from './screen/Settings'
import { Memory } from './screen/settings/Memory'
import { People } from './screen/settings/People'
import { ThemeProvider, useTheme } from './theme'
import { Recover } from './ui/Recover'
import { Button, Face, GUTTER, Label } from './ui/ui'
import { MeProvider, type Routes } from './workspace'

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
        <Shell />
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
        backgroundColor: c['surface-0'],
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
 * an error; but a Person who has waited a while is told what to check and given the way out,
 * because the usual reason is a server that is not running or a phone on another network.
 */
function Connecting() {
  const data = useLiveData()
  const leave = useLeave()
  const { colors: c } = useTheme()
  const waited = AsyncResult.isSuccess(useDoor(patienceAtom))
  const where = serverName(data.session.server)
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingHorizontal: GUTTER + 12,
        backgroundColor: c['surface-0'],
      }}
    >
      <Face size={44} mood="thinking" />
      <Label size="headline" style={{ marginTop: 8, textAlign: 'center' }}>
        {waited ? 'Still trying to reach Vivid' : 'Connecting…'}
      </Label>
      <Label size="label" tone="ink-3" style={{ textAlign: 'center', maxWidth: 300 }}>
        {waited
          ? `Nothing has answered at ${where} yet. Check that Vivid is running there and that this phone is on the same network. It will connect by itself when it can.`
          : where}
      </Label>
      {waited && (
        <View style={{ marginTop: 14 }}>
          <Button label="Sign out and choose a server" onPress={leave} />
        </View>
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
        backgroundColor: c['surface-0'],
      }}
    >
      <Face size={44} mood="neutral" />
      <Label size="headline" style={{ marginTop: 8, textAlign: 'center' }}>
        Vivid cannot open this account
      </Label>
      <Label size="label" tone="ink-3" style={{ textAlign: 'center', maxWidth: 300 }}>
        {message}
      </Label>
      <View style={{ marginTop: 14 }}>
        <Button label="Sign out" onPress={leave} />
      </View>
    </View>
  )
}

/**
 * The signed-in app: one native stack. Pushing, popping and the back swipe are the platform's
 * own; nothing here animates a screen. Each screen draws its own bar (`ui/Header.tsx`), so the
 * native one is off everywhere.
 */
function Shell() {
  const { colors: c, dark } = useTheme()
  const base = dark ? DarkTheme : DefaultTheme
  return (
    <NavigationContainer
      theme={{
        ...base,
        colors: {
          ...base.colors,
          background: c['surface-0'],
          card: c['surface-0'],
          text: c.ink,
          primary: c.accent,
          border: c['line-2'],
        },
      }}
    >
      <Stack.Navigator
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c['surface-0'] } }}
      >
        <Stack.Screen name="Home" component={Home} />
        <Stack.Screen name="Chat" component={Chat} />
        <Stack.Screen name="Routines" component={Routines} />
        <Stack.Screen name="Library" component={Library} />
        <Stack.Screen name="Folder" component={Folder} />
        <Stack.Screen name="Projects" component={Projects} />
        <Stack.Screen name="Project" component={Project} />
        <Stack.Screen name="Settings" component={Settings} />
        <Stack.Screen name="People" component={People} />
        <Stack.Screen name="Memory" component={Memory} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
