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

async function saveRuntimeThread(thread: RuntimeConversation) {
  const response = await fetch(`/api/conversations/${encodeURIComponent(thread.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(thread),
  });
  if (!response.ok) throw new Error(`Could not save conversation (${response.status})`);
}

export default function App() {
  const [view, setView] = useState<View>(() => (location.search.includes("tokens") ? "tokens" : location.search.includes("empty") ? "empty" : location.search.includes("library") ? "library" : location.search.includes("projects") ? "projects" : location.search.includes("routines") ? "routines" : "conversation"));
  const [runtimeThreads, setRuntimeThreads] = useState<RuntimeConversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [threadsReady, setThreadsReady] = useState(false);
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
    let cancelled = false;

    async function loadThreads() {
      const response = await fetch("/api/conversations");
      if (!response.ok) throw new Error(`Could not load conversations (${response.status})`);
      const body = await response.json() as { conversations: RuntimeConversation[] };
      let conversations = body.conversations;

      if (conversations.length === 0) {
        try {
          const legacy = localStorage.getItem("konan-runtime-conversations");
          const parsed = legacy ? JSON.parse(legacy) as RuntimeConversation[] : [];
          if (parsed.length > 0) {
            await Promise.all(parsed.map(saveRuntimeThread));
            conversations = parsed.sort((left, right) => right.updatedAt - left.updatedAt);
          }
        } catch {
          // Ignore a corrupt legacy index; new conversations still work.
        }
      }

      localStorage.removeItem("konan-runtime-conversations");
      if (!cancelled) {
        setRuntimeThreads(conversations);
        setActiveId((current) => current ?? conversations[0]?.id ?? null);
        setThreadsReady(true);
      }
    }

    void loadThreads().catch(() => {
      if (!cancelled) setThreadsReady(true);
    });
    return () => { cancelled = true; };
  }, []);

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
    void saveRuntimeThread(thread);
  }

  function recordMessage(id: string, message: string) {
    const current = runtimeThreads.find((thread) => thread.id === id);
    if (!current) return;
    const changed = {
      ...current,
      title: current.title === "New conversation" ? titleFromMessage(message) : current.title,
      preview: message,
      updatedAt: Date.now(),
    };
    setRuntimeThreads((threads) => [
      changed,
      ...threads.filter((thread) => thread.id !== id),
    ]);
    void saveRuntimeThread(changed);
  }

  function openRuntimeConversation(thread: RuntimeConversation) {
    setRuntimeThreads((current) => [
      thread,
      ...current.filter((item) => item.id !== thread.id),
    ].sort((left, right) => right.updatedAt - left.updatedAt));
    setActiveId(thread.id);
    setView("conversation");
    setPanel(null);
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
        {view === "routines" && <Routines onOpenConversation={openRuntimeConversation} />}
        {view === "demo" && <DemoConversation conversationId={activeDemoId} />}
        {view === "conversation" && (
          activeId ? <Conversation
            conversationId={activeId ?? "t1"}
            title={activeThread?.title ?? "Conversation"}
            onMessageSent={(message) => recordMessage(activeId ?? "t1", message)}
            panelOpen={panel !== null}
            onOpenPanel={(k) => setPanel((cur) => (cur === k ? null : k))}
          /> : <div className="flex flex-1 items-center justify-center text-label text-ink-4">{threadsReady ? "Start a new conversation" : "Loading conversations…"}</div>
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
