import { createContext, useContext } from "react";
import { useWindowDimensions } from "react-native";
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import type { Api, Connection } from "./lib/api";
import type { ThemePreference } from "./theme";
import { deriveLayout } from "./lib/layout";
import { resolveThreadSelectionNavigationAction } from "./lib/adaptive-navigation";
export type Routes = {
  Home: undefined;
  Chat: { id: string; title: string; draft?: string; sendOnOpen?: boolean };
  Today: undefined;
  Routines: undefined;
  Library: undefined;
  Projects: undefined;
  Connectors: undefined;
  Settings: undefined;
};
export type Preferences = Connection & {
  theme: ThemePreference;
  pinnedThreads?: string[];
  settledThreads?: string[];
};
export const WorkspaceContext = createContext<{
  api: Api;
  preferences: Preferences;
  savePreferences: (next: Preferences) => Promise<void>;
  createThread: (draft?: string) => Promise<{ id: string; title: string; draft?: string }>;
}>(null!);
export const useWorkspace = () => useContext(WorkspaceContext);
export const SidebarContext = createContext({
  open: () => {},
  close: () => {},
  activeThread: "",
  activeRoute: "Home",
});
export const useSidebar = () => useContext(SidebarContext);
export type ThreadActivity = "ready" | "working" | "attention" | "approve" | "failed" | "done";
export const ActivityContext = createContext<{
  activity: Record<string, ThreadActivity>;
  report: (id: string, status: ThreadActivity | undefined) => void;
}>({ activity: {}, report: () => {} });
export const useThreadActivity = () => useContext(ActivityContext);
export function useOpenThread() {
  const sidebar = useSidebar();
  const navigation = useNavigation<NavigationProp<Routes>>();
  const dimensions = useWindowDimensions();
  return (id: string, title: string, draft?: string) => {
    sidebar.close();
    const current = navigation.getState()?.routes.at(-1);
    const action = resolveThreadSelectionNavigationAction({
      usesSplitView: deriveLayout(dimensions).usesSplitView,
      pathname:
        current?.name === "Home"
          ? "/"
          : current?.name === "Chat"
            ? `/threads/vivid/${id}`
            : `/${current?.name}`,
    });
    if (action === "set-params") navigation.navigate("Chat", { id, title, draft });
    else if (action === "replace")
      navigation.reset({
        index: 1,
        routes: [{ name: "Home" }, { name: "Chat", params: { id, title, draft } }],
      });
    else navigation.navigate("Chat", { id, title, draft });
  };
}
