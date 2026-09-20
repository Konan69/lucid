import { useCallback, useEffect, useMemo, useState } from 'react'
import * as Schema from 'effect/Schema'
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StatusBar,
  View,
  useWindowDimensions,
} from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import * as SecureStore from 'expo-secure-store'
import { randomUUID } from 'expo-crypto'
import { fetch as expoFetch } from 'expo/fetch'
import { createApi } from './lib/api'
import { deriveLayout, type Layout } from './lib/layout'
import {
  ActivityContext,
  type ThreadActivity,
  SidebarContext,
  WorkspaceContext,
  type Preferences,
  type Routes,
} from './workspace'
import { ThemeProvider, useTheme } from './theme'
import { Home } from './screens/Home'
import { Welcome } from './screens/Welcome'
import { Chat } from './screens/Chat'
import { Routines } from './screens/Routines'
import { Library } from './screens/Library'
import { Projects, Connectors, Settings } from './screens/Workspace'

import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { WORKSPACE_PANE_TIMING } from './t3/pane'
import { nativeMetrics as m } from '@vivid/tokens/native'

const SavedPreferencesSchema = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  theme: Schema.Literals(['light', 'dark', 'system'] as const),
  pinnedThreads: Schema.optional(Schema.Array(Schema.String)),
  settledThreads: Schema.optional(Schema.Array(Schema.String)),
})
const decodeSavedPreferencesJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(SavedPreferencesSchema),
)
function decodeSavedPreferences(value: string) {
  return decodeSavedPreferencesJson(value)
}
const defaultPreferences: Preferences = {
  url:
    globalThis.process.env.EXPO_PUBLIC_API_URL ??
    (Platform.OS === 'android' ? 'http://10.0.2.2:5178' : 'http://localhost:5178'),
  token: '',
  theme: 'system',
}
const Stack = createNativeStackNavigator<Routes>()

type ShellContentProps = {
  readonly colors: ReturnType<typeof useTheme>['colors']
  readonly dark: boolean
  readonly layout: Layout
  readonly drawerOpen: boolean
  readonly drawerVisible: boolean
  readonly drawerWidth: number
  readonly close: () => void
  readonly paneStyle: ReturnType<typeof useAnimatedStyle>
  readonly scrimStyle: ReturnType<typeof useAnimatedStyle>
}

/** Renders the compact overlay drawer while the shell retains animation ownership. */
function CompactDrawer({
  colors: c,
  drawerOpen,
  drawerVisible,
  drawerWidth,
  close,
  paneStyle,
  scrimStyle,
}: Omit<ShellContentProps, 'dark' | 'layout'>) {
  return (
    <>
      {(drawerOpen || drawerVisible) && (
        <Animated.View
          style={[{ position: 'absolute', inset: 0, backgroundColor: c.scrim }, scrimStyle]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close sidebar"
            onPress={close}
            style={{ flex: 1 }}
          />
        </Animated.View>
      )}
      <Animated.View
        collapsable={false}
        pointerEvents={drawerOpen ? 'auto' : 'none'}
        accessibilityElementsHidden={!drawerOpen}
        importantForAccessibility={drawerOpen ? 'auto' : 'no-hide-descendants'}
        style={[
          {
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: drawerWidth,
            backgroundColor: c['surface-1'],
            borderRightWidth: 0.5,
            borderRightColor: c['line-3'],
            display: drawerOpen || drawerVisible ? 'flex' : 'none',
          },
          paneStyle,
        ]}
      >
        <Home embedded />
      </Animated.View>
    </>
  )
}

/** Renders the responsive workspace panes without owning shell state or navigation policy. */
function ShellContent({
  colors: c,
  dark,
  layout,
  drawerOpen,
  drawerVisible,
  drawerWidth,
  close,
  paneStyle,
  scrimStyle,
}: ShellContentProps) {
  return (
    <>
      <StatusBar barStyle={dark ? 'light-content' : 'dark-content'} />
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          backgroundColor: c['surface-1'],
          overflow: 'hidden',
        }}
      >
        {layout.usesSplitView && layout.listPaneWidth !== null && (
          <View style={{ width: layout.listPaneWidth }}>
            <Home embedded />
          </View>
        )}
        <View
          collapsable={false}
          style={{ flex: 1, minWidth: 0 }}
          accessibilityElementsHidden={!layout.usesSplitView && drawerOpen}
          importantForAccessibility={
            !layout.usesSplitView && drawerOpen ? 'no-hide-descendants' : 'auto'
          }
        >
          <Stack.Navigator
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: c['surface-0'] },
            }}
          >
            <Stack.Screen name="Home" component={Welcome} />
            <Stack.Screen name="Chat" component={Chat} />
            <Stack.Screen name="Routines" component={Routines} />
            <Stack.Screen name="Library" component={Library} />
            <Stack.Screen name="Projects" component={Projects} />
            <Stack.Screen name="Connectors" component={Connectors} />
            <Stack.Screen name="Settings" component={Settings} />
          </Stack.Navigator>
        </View>
        {!layout.usesSplitView && (
          <CompactDrawer
            colors={c}
            drawerOpen={drawerOpen}
            drawerVisible={drawerVisible}
            drawerWidth={drawerWidth}
            close={close}
            paneStyle={paneStyle}
            scrimStyle={scrimStyle}
          />
        )}
      </View>
    </>
  )
}

function Shell() {
  const { colors: c, dark } = useTheme()
  const dimensions = useWindowDimensions()
  const layout = deriveLayout(dimensions)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerVisible, setDrawerVisible] = useState(false)
  const [previousLayoutVariant, setPreviousLayoutVariant] = useState(layout.variant)
  const progress = useSharedValue(0)
  const drawerWidth = Math.min(dimensions.width - 48, m['sidebar-w'] * 1.15)
  const [activeThread, setActiveThread] = useState('')
  const [activeRoute, setActiveRoute] = useState('Home')
  const [activity, setActivity] = useState<Record<string, ThreadActivity>>({})
  const report = useCallback((id: string, status?: ThreadActivity) => {
    setActivity((current) => {
      if (current[id] === status) return current
      const next = { ...current }
      if (status) next[id] = status
      else delete next[id]
      return next
    })
  }, [])
  // A layout-mode change owns a fresh compact drawer state; split mode renders its own sidebar.
  if (previousLayoutVariant !== layout.variant) {
    setPreviousLayoutVariant(layout.variant)
    setDrawerOpen(false)
    setDrawerVisible(false)
  }
  const setDrawer = useCallback(
    (open: boolean) => {
      if (open) {
        Keyboard.dismiss()
        setDrawerVisible(true)
      }
      setDrawerOpen(open)
      progress.set(
        withTiming(open ? 1 : 0, WORKSPACE_PANE_TIMING, (finished) => {
          if (finished && !open) runOnJS(setDrawerVisible)(false)
        }),
      )
    },
    [progress],
  )
  const close = useCallback(() => setDrawer(false), [setDrawer])
  const open = useCallback(() => setDrawer(true), [setDrawer])
  useEffect(() => {
    if (!drawerOpen) return () => {}
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      close()
      return true
    })
    return () => listener.remove()
  }, [drawerOpen, close])
  useEffect(() => {
    if (layout.usesSplitView) progress.set(0)
  }, [layout.usesSplitView, progress])
  const paneStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (progress.get() - 1) * drawerWidth }],
    opacity: Math.min(1, (progress.get() * drawerWidth) / 80),
  }))
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.get() }))
  const activityContextValue = useMemo(() => ({ activity, report }), [activity, report])
  const sidebarContextValue = useMemo(
    () => ({ open, close, activeThread, activeRoute }),
    [open, close, activeThread, activeRoute],
  )
  const theme = {
    ...(dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(dark ? DarkTheme : DefaultTheme).colors,
      background: c['surface-0'],
      card: c['surface-0'],
      text: c.ink,
      primary: c.accent,
      border: c['line-2'],
    },
  }
  return (
    <NavigationContainer
      theme={theme}
      onStateChange={(state) => {
        if (state === undefined) return
        const route = state.routes[state.index]
        const nextRoute = route === undefined ? 'Home' : route.name
        // SAFETY: React Navigation supplies Chat route params whenever the route name is Chat.
        const nextThread =
          route !== undefined && route.name === 'Chat' ? (route.params as Routes['Chat']).id : ''
        setActiveRoute(nextRoute)
        setActiveThread(nextThread)
        // A title/stream update must not dismiss a sidebar the user is reading.
        if (nextRoute !== activeRoute || nextThread !== activeThread) close()
      }}
    >
      <ActivityContext.Provider value={activityContextValue}>
        <SidebarContext.Provider value={sidebarContextValue}>
          <ShellContent
            colors={c}
            dark={dark}
            layout={layout}
            drawerOpen={drawerOpen}
            drawerVisible={drawerVisible}
            drawerWidth={drawerWidth}
            close={close}
            paneStyle={paneStyle}
            scrimStyle={scrimStyle}
          />
        </SidebarContext.Provider>
      </ActivityContext.Provider>
    </NavigationContainer>
  )
}

export default function App() {
  const [preferences, setPreferences] = useState(defaultPreferences)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    const savedPreferences =
      Platform.OS === 'web'
        ? Promise.resolve(localStorage.getItem('vivid-mobile'))
        : SecureStore.getItemAsync('vivid-mobile')

    // Preferences arrive from an external store. The asynchronous continuation prevents stale
    // storage reads from updating an App instance that has already unmounted.
    void savedPreferences
      .then((saved) => {
        if (!saved || cancelled) return
        const parsed = decodeSavedPreferences(saved)
        const { url, token, theme, pinnedThreads = [], settledThreads = [] } = parsed
        createApi({ url, token })
        setPreferences({
          url,
          token,
          theme,
          pinnedThreads: [...pinnedThreads],
          settledThreads: [...settledThreads],
        })
      })
      .catch(() => {
        /* An invalid preference file falls back to the initial connection. */
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })

    return () => {
      cancelled = true
    }
  }, [])
  const api = useMemo(
    () =>
      createApi(
        { url: preferences.url, token: preferences.token },
        // SAFETY: expo/fetch exposes the Fetch API signature expected by the Flue and API clients.
        expoFetch.bind(globalThis) as typeof fetch,
      ),
    [preferences.url, preferences.token],
  )
  const savePreferences = useCallback(async (next: Preferences) => {
    createApi(next)
    // Preview does not persist credentials in browser storage.
    if (Platform.OS === 'web')
      localStorage.setItem('vivid-mobile', JSON.stringify({ ...next, token: '' }))
    else await SecureStore.setItemAsync('vivid-mobile', JSON.stringify(next))
    setPreferences(next)
  }, [])
  const createThread = useCallback(
    async (draft?: string) => {
      const thread = {
        id: randomUUID(),
        title: 'New conversation',
        preview: '',
        updatedAt: Date.now(),
        archived: false,
      }
      await api.request(`/api/conversations/${thread.id}`, 'PUT', thread)
      return { id: thread.id, title: thread.title, draft }
    },
    [api],
  )
  const workspaceContextValue = useMemo(
    () => ({ api, preferences, savePreferences, createThread }),
    [api, preferences, savePreferences, createThread],
  )
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider preference={preferences.theme}>
          <WorkspaceContext.Provider value={workspaceContextValue}>
            {ready && <Shell />}
          </WorkspaceContext.Provider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
