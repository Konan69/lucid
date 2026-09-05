import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StatusBar,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import { fetch as expoFetch } from "expo/fetch";
import { createApi } from "./lib/api";
import { deriveLayout } from "./lib/layout";
import {
  ActivityContext,
  type ThreadActivity,
  SidebarContext,
  WorkspaceContext,
  type Preferences,
  type Routes,
} from "./workspace";
import { ThemeProvider, useTheme } from "./theme";
import { Home } from "./screens/Home";
import { Welcome } from "./screens/Welcome";
import { Chat } from "./screens/Chat";
import { Routines } from "./screens/Routines";
import { Library } from "./screens/Library";
import { Projects, Connectors, Settings } from "./screens/Workspace";

import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { WORKSPACE_PANE_TIMING } from "./t3/workspace-pane-animation";
import { nativeMetrics as m } from "@konan/design-tokens/native";

const defaultPreferences: Preferences = {
  url:
    process.env.EXPO_PUBLIC_API_URL ??
    (Platform.OS === "android" ? "http://10.0.2.2:5178" : "http://localhost:5178"),
  token: "",
  theme: "system",
};
const Stack = createNativeStackNavigator<Routes>();

function Shell() {
  const { colors: c, dark } = useTheme();
  const dimensions = useWindowDimensions();
  const layout = deriveLayout(dimensions);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const progress = useSharedValue(0);
  const drawerWidth = Math.min(dimensions.width - 48, m["sidebar-w"] * 1.15);
  const [activeThread, setActiveThread] = useState("");
  const [activeRoute, setActiveRoute] = useState("Home");
  const [activity, setActivity] = useState<Record<string, ThreadActivity>>({});
  const report = useCallback((id: string, status: ThreadActivity | undefined) => {
    setActivity((current) => {
      if (current[id] === status) return current;
      const next = { ...current };
      if (status) next[id] = status;
      else delete next[id];
      return next;
    });
  }, []);
  const close = useCallback(() => setDrawerOpen(false), []);
  const open = useCallback(() => {
    Keyboard.dismiss();
    setDrawerOpen(true);
  }, []);
  useEffect(() => {
    if (drawerOpen) setDrawerVisible(true);
    progress.value = withTiming(drawerOpen ? 1 : 0, WORKSPACE_PANE_TIMING, (finished) => {
      if (finished && !drawerOpen) runOnJS(setDrawerVisible)(false);
    });
  }, [drawerOpen, progress]);
  useEffect(() => {
    if (!drawerOpen) return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => listener.remove();
  }, [drawerOpen, close]);
  useEffect(close, [layout.usesSplitView, close]);
  const paneStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (progress.value - 1) * drawerWidth }],
    opacity: Math.min(1, (progress.value * drawerWidth) / 80),
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const theme = {
    ...(dark ? DarkTheme : DefaultTheme),
    colors: {
      ...(dark ? DarkTheme : DefaultTheme).colors,
      background: c["surface-0"],
      card: c["surface-0"],
      text: c.ink,
      primary: c.accent,
      border: c["line-2"],
    },
  };
  return (
    <NavigationContainer
      theme={theme}
      onStateChange={(state) => {
        const route = state?.routes[state.index];
        const nextRoute = route?.name ?? "Home";
        const nextThread = route?.name === "Chat" ? (route.params as Routes["Chat"]).id : "";
        setActiveRoute(nextRoute);
        setActiveThread(nextThread);
        // A title/stream update must not dismiss a sidebar the user is reading.
        if (nextRoute !== activeRoute || nextThread !== activeThread) close();
      }}
    >
      <ActivityContext.Provider value={{ activity, report }}>
        <SidebarContext.Provider value={{ open, close, activeThread, activeRoute }}>
          <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              backgroundColor: c["surface-1"],
              overflow: "hidden",
            }}
          >
            {layout.usesSplitView && (
              <View style={{ width: layout.listPaneWidth! }}>
                <Home embedded />
              </View>
            )}
            <View
              collapsable={false}
              style={{ flex: 1, minWidth: 0 }}
              accessibilityElementsHidden={!layout.usesSplitView && drawerOpen}
              importantForAccessibility={
                !layout.usesSplitView && drawerOpen ? "no-hide-descendants" : "auto"
              }
            >
              <Stack.Navigator
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: c["surface-0"] },
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
              <>
                {(drawerOpen || drawerVisible) && (
                  <Animated.View
                    style={[
                      { position: "absolute", inset: 0, backgroundColor: c.scrim },
                      scrimStyle,
                    ]}
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
                  pointerEvents={drawerOpen ? "auto" : "none"}
                  accessibilityElementsHidden={!drawerOpen}
                  importantForAccessibility={drawerOpen ? "auto" : "no-hide-descendants"}
                  style={[
                    {
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: drawerWidth,
                      backgroundColor: c["surface-1"],
                      borderRightWidth: 0.5,
                      borderRightColor: c["line-3"],
                      display: drawerOpen || drawerVisible ? "flex" : "none",
                    },
                    paneStyle,
                  ]}
                >
                  <Home embedded />
                </Animated.View>

              </>
            )}
          </View>
        </SidebarContext.Provider>
      </ActivityContext.Provider>
    </NavigationContainer>
  );
}

export default function App() {
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    async function load() {
      try {
        const saved =
          Platform.OS === "web"
            ? localStorage.getItem("vivid-mobile")
            : await SecureStore.getItemAsync("vivid-mobile");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (
            typeof parsed.url === "string" &&
            typeof parsed.token === "string" &&
            ["light", "dark", "system"].includes(parsed.theme)
          ) {
            createApi(parsed);
            setPreferences({
              ...parsed,
              pinnedThreads: Array.isArray(parsed.pinnedThreads)
                ? parsed.pinnedThreads.filter((id: unknown) => typeof id === "string")
                : [],
              settledThreads: Array.isArray(parsed.settledThreads)
                ? parsed.settledThreads.filter((id: unknown) => typeof id === "string")
                : [],
            });
          }
        }
      } catch {
        /* An invalid preference file falls back to the initial connection. */
      }
      setReady(true);
    }
    void load();
  }, []);
  const api = useMemo(
    () => createApi(preferences, expoFetch.bind(globalThis) as typeof fetch),
    [preferences.url, preferences.token],
  );
  async function savePreferences(next: Preferences) {
    createApi(next);
    // Preview does not persist credentials in browser storage.
    if (Platform.OS === "web")
      localStorage.setItem("vivid-mobile", JSON.stringify({ ...next, token: "" }));
    else await SecureStore.setItemAsync("vivid-mobile", JSON.stringify(next));
    setPreferences(next);
  }
  async function createThread(draft?: string) {
    const thread = {
      id: randomUUID(),
      title: "New conversation",
      preview: "",
      updatedAt: Date.now(),
      archived: false,
    };
    await api.request(`/api/conversations/${thread.id}`, "PUT", thread);
    return { id: thread.id, title: thread.title, draft };
  }
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider preference={preferences.theme}>
          <WorkspaceContext.Provider value={{ api, preferences, savePreferences, createThread }}>
            {ready && <Shell />}
          </WorkspaceContext.Provider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
