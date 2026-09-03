import { Moon, Sun, SwatchBook } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { EmptyState } from "./screen/EmptyState";
import { Library } from "./screen/Library";
import { Routines } from "./screen/Routines";
import { Projects } from "./screen/Projects";
import { Panel } from "./screen/Panel";
import { Sidebar } from "./screen/Sidebar";
import { Settings, type ThemePreference } from "./screen/Settings";
import { Conversation, DemoConversation } from "./screen/Conversation";
import { Tokens } from "./screen/Tokens";
import { IconButton } from "./ui/Button";
import {
  initialRuntimeConversations,
  titleFromMessage,
  type RuntimeConversation,
} from "./data/runtimeConversations";

type View = "conversation" | "demo" | "empty" | "tokens" | "library" | "projects" | "routines";

function subscribeToSystemTheme(onChange: () => void) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function initialTheme(): ThemePreference {
  const saved = localStorage.getItem("konan-theme");
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

function initialRuntimeThreads(): RuntimeConversation[] {
  try {
    const saved = localStorage.getItem("konan-runtime-conversations");
    if (saved) return JSON.parse(saved) as RuntimeConversation[];
  } catch {
    // A corrupt local index should not prevent access to the durable conversations.
  }
  return initialRuntimeConversations;
}

export default function App() {
  const [view, setView] = useState<View>(() => (location.search.includes("tokens") ? "tokens" : location.search.includes("empty") ? "empty" : location.search.includes("library") ? "library" : location.search.includes("projects") ? "projects" : location.search.includes("routines") ? "routines" : "conversation"));
  const [runtimeThreads, setRuntimeThreads] = useState<RuntimeConversation[]>(initialRuntimeThreads);
  const [activeId, setActiveId] = useState<string | null>(() => initialRuntimeThreads()[0]?.id ?? null);
  const [activeDemoId, setActiveDemoId] = useState("t5");
  const [panel, setPanel] = useState<"screen" | "log" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(initialTheme);
  const systemTheme = useSyncExternalStore(subscribeToSystemTheme, getSystemTheme, () => "light");
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    localStorage.setItem("konan-theme", theme);
  }, [resolvedTheme, theme]);

  useEffect(() => {
    localStorage.setItem("konan-runtime-conversations", JSON.stringify(runtimeThreads));
  }, [runtimeThreads]);

  function createConversation() {
    const thread: RuntimeConversation = {
      id: crypto.randomUUID(),
      title: "New conversation",
      preview: "No messages yet",
      updatedAt: Date.now(),
    };
    setRuntimeThreads((current) => [thread, ...current]);
    setActiveId(thread.id);
    setView("conversation");
    setPanel(null);
  }

  function recordMessage(id: string, message: string) {
    setRuntimeThreads((current) => current
      .map((thread) => thread.id === id ? {
        ...thread,
        title: thread.title === "New conversation" ? titleFromMessage(message) : thread.title,
        preview: message,
        updatedAt: Date.now(),
      } : thread)
      .sort((left, right) => right.updatedAt - left.updatedAt));
  }

  const activeThread = runtimeThreads.find((thread) => thread.id === activeId);

  return (
    <div className="flex h-full w-full">
      {view !== "tokens" && (
        <Sidebar
          activeId={view === "demo" ? activeDemoId : view === "empty" ? null : activeId}
          runtimeConversations={runtimeThreads}
          onSelect={(id) => { if (id === "new") createConversation(); else if (id === "library") setView("library"); else if (id === "projects") setView("projects"); else if (id === "routines") setView("routines"); else if (id.startsWith("demo:")) { setActiveDemoId(id.slice(5)); setView("demo"); } else { setActiveId(id); setView("conversation"); } }}
          onOpenSettings={() => setSettingsOpen(true)}
          workingCount={0}
        />
      )}
      <main className="flex min-w-0 flex-1">
        {view === "tokens" && <Tokens />}
        {view === "empty" && <EmptyState />}
        {view === "library" && <Library />}
        {view === "projects" && <Projects />}
        {view === "routines" && <Routines />}
        {view === "demo" && <DemoConversation conversationId={activeDemoId} />}
        {view === "conversation" && (
          <Conversation
            conversationId={activeId ?? "t1"}
            title={activeThread?.title ?? "Conversation"}
            onMessageSent={(message) => recordMessage(activeId ?? "t1", message)}
            panelOpen={panel !== null}
            onOpenPanel={(k) => setPanel((cur) => (cur === k ? null : k))}
          />
        )}
        {view === "conversation" && panel && <Panel kind={panel} onClose={() => setPanel(null)} />}
      </main>

      {/* Dev-only switches. Not product UI. */}
      <div className="fixed bottom-3 right-3 z-50 flex gap-1 rounded-full bg-surface-3 p-1 shadow-popup ring-line">
        <IconButton label="Token sheet" active={view === "tokens"} onClick={() => setView(view === "tokens" ? "conversation" : "tokens")}>
          <SwatchBook className="size-4" />
        </IconButton>
        <IconButton label="Toggle theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </IconButton>
      </div>
      {settingsOpen && <Settings theme={theme} onThemeChange={setTheme} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
