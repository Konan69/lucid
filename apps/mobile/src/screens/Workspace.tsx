import { useState } from "react";
import { Image, Linking, RefreshControl, ScrollView, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Check, ChevronRight, Plug } from "lucide-react-native";
import { useWorkspace, type Routes } from "../workspace";
import { useResource } from "../lib/resource";
import { normalizeServerUrl } from "../lib/api";
import { Card, ControlPill, Feedback, Field, Header, Label, Sheet, styles } from "../components/ui";
import { ToolMark } from "../components/ToolMark";
import { useTheme, type ThemePreference } from "../theme";
import { projects, type Project } from "../../../web/src/data/projects";

const covers = {
  "/covers/kashplus.png": require("../../../web/public/covers/kashplus.png"),
  "/covers/interlink.png": require("../../../web/public/covers/interlink.png"),
  "/covers/arkchain.png": require("../../../web/public/covers/arkchain.png"),
  "/covers/rwa.png": require("../../../web/public/covers/rwa.png"),
  "/covers/arkade.png": require("../../../web/public/covers/arkade.png"),
  "/covers/kash.png": require("../../../web/public/covers/kash.png"),
};

/** Resolves a fixture cover only when the project path belongs to this bundled asset table. */
function coverFor(path: string) {
  if (!Object.hasOwn(covers, path)) return undefined;
  // SAFETY: Object.hasOwn verifies that path is an own key of covers before indexing it.
  return covers[path as keyof typeof covers];
}
export function Projects({ navigation }: NativeStackScreenProps<Routes, "Projects">) {
  const [path, setPath] = useState<Project[]>([]);
  const selected = path.at(-1);
  const projectTitle = selected === undefined ? "Projects" : selected.name;
  const [query, setQuery] = useState("");
  const items = selected ? (selected.children ?? []) : projects;
  return (
    <View style={{ flex: 1 }}>
      <Header
        title={projectTitle}
        onBack={() => (selected ? setPath((p) => p.slice(0, -1)) : navigation.goBack())}
      />
      <ScrollView contentContainerStyle={styles.page}>
        <Label size="label" tone="ink-3">
          Workspace preview · sample projects
        </Label>
        {selected && (
          <>
            <Image
              source={coverFor(selected.cover)}
              style={{ height: 170, width: "100%", borderRadius: 18 }}
            />
            <Label size="headline">{selected.brief}</Label>
            <Label tone="ink-3" size="label">
              {selected.members.map((m) => m.name).join(", ")} · {selected.teams.join(", ")}
            </Label>
            <Label size="headline">Conversations</Label>
            {selected.conversations.map((title) => (
              <Card key={title}>
                <Label>{title}</Label>
                <Label size="micro" tone="ink-3">
                  Sample conversation
                </Label>
              </Card>
            ))}
            {!!items.length && <Label size="headline">Inside this project</Label>}
          </>
        )}
        <Field
          accessibilityLabel="Find a project"
          placeholder="Find a project…"
          value={query}
          onChangeText={setQuery}
        />
        {items
          .filter((p) => `${p.name} ${p.brief}`.toLowerCase().includes(query.toLowerCase()))
          .map((p) => (
            <Card key={p.id} style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <Image source={coverFor(p.cover)} style={{ width: 56, height: 56, borderRadius: 12 }} />
              <View style={{ flex: 1, gap: 6 }}>
                <Label size="headline">{p.name}</Label>
                <Label tone="ink-3" size="label">
                  {p.brief}
                </Label>
                <View style={styles.row}>
                  <Label size="micro" tone="ink-3" style={{ flex: 1 }}>
                    {p.members.length} people · {p.conversationCount} conversations
                  </Label>
                  <ControlPill
                    icon={ChevronRight}
                    accessibilityLabel={`Open ${p.name}`}
                    onPress={() => {
                      setPath((v) => [...v, p]);
                      setQuery("");
                    }}
                  />
                </View>
              </View>
            </Card>
          ))}
      </ScrollView>
    </View>
  );
}

type Connector = {
  id: string;
  status: string;
  metadata: { name: string; description: string };
};
export function Connectors({ navigation }: NativeStackScreenProps<Routes, "Connectors">) {
  const { api } = useWorkspace();
  const { colors: c } = useTheme();
  const resource = useResource<{ connectors: Connector[] }>(api, "/api/connectors");
  const connectorData = resource.data;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  async function change(connector: Connector) {
    setBusy(connector.id);
    setError("");
    try {
      if (connector.status === "connected")
        await api.request(`/api/connectors/${connector.id}`, "DELETE");
      else {
        const { authUrl } = await api.request<{ authUrl: string }>(
          `/api/connectors/${connector.id}/auth`,
        );
        if (!/^https?:\/\//i.test(authUrl))
          throw new Error("The connection returned an invalid sign-in address.");
        await Linking.openURL(authUrl);
      }
      await resource.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <View style={{ flex: 1 }}>
      <Header title="Connectors" onBack={() => navigation.goBack()} />
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={resource.loading} onRefresh={resource.refresh} />
        }
        contentContainerStyle={styles.page}
      >
        <Label tone="ink-3">
          Connect the tools you want Vivid to work with. You can disconnect any time.
        </Label>
        <Feedback
          error={error || resource.error}
          loading={resource.loading}
          retry={resource.refresh}
        />
        {connectorData !== undefined && connectorData.connectors.map((item) => (
          <Card key={item.id}>
            <View style={styles.row}>
              <ToolMark id={item.id} size={28} />
              <Label style={{ flex: 1 }}>{item.metadata.name}</Label>
              {item.status === "connected" && <Check size={18} color={c["status-success"]} />}
            </View>
            <Label tone="ink-3" size="label">
              {item.metadata.description}
            </Label>
            <ControlPill
              label={
                busy === item.id
                  ? "One moment…"
                  : item.status === "connected"
                    ? "Disconnect"
                    : "Connect"
              }
              disabled={!!busy}
              onPress={() => void change(item)}
            />
          </Card>
        ))}
        {connectorData !== undefined && connectorData.connectors.length === 0 && (
          <Label tone="ink-3">No connectors are available on this server yet.</Label>
        )}
      </ScrollView>
    </View>
  );
}

export function Settings({ navigation }: NativeStackScreenProps<Routes, "Settings">) {
  const { preferences, savePreferences } = useWorkspace();
  const [url, setUrl] = useState(preferences.url);
  const [token, setToken] = useState(preferences.token);
  const [theme, setTheme] = useState<ThemePreference>(preferences.theme);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [about, setAbout] = useState(false);
  return (
    <View style={{ flex: 1 }}>
      <Header title="Settings" onBack={() => navigation.goBack()} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.page}
      >
        <Card>
          <Label size="headline">Appearance</Label>
          <View style={styles.wrap}>
            {(["system", "light", "dark"] as const).map((value) => (
              <ControlPill
                key={value}
                primary={theme === value}
                label={value === "system" ? "Follow device" : value === "dark" ? "Dark" : "Light"}
                onPress={() => {
                  setTheme(value);
                  void savePreferences({ ...preferences, theme: value }).catch((e) =>
                    setError(e.message),
                  );
                }}
              />
            ))}
          </View>
        </Card>
        <Card>
          <ControlPill
            icon={Plug}
            label="Connectors"
            onPress={() => navigation.navigate("Connectors")}
          />
          <Label size="label" tone="ink-3">
            Manage the services Vivid can use.
          </Label>
        </Card>
        <Card>
          <Label size="headline">Your Vivid</Label>
          <Label size="label" tone="ink-3">
            Use the address of your Vivid server. On a phone, use your computer’s network address.
          </Label>
          <Field
            accessibilityLabel="Server address"
            placeholder="https://vivid.example.com"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Field
            accessibilityLabel="Access token"
            placeholder="Access token (direct runtime only)"
            secureTextEntry
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Feedback error={error} />
          {!!notice && (
            <Label size="label" tone="status-success">
              {notice}
            </Label>
          )}
          <ControlPill
            primary
            label={busy ? "Saving…" : "Save connection"}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              setError("");
              setNotice("");
              void (async () => {
                const normalized = normalizeServerUrl(url);
                await savePreferences({
                  ...preferences,
                  url: normalized,
                  token: token.trim(),
                  theme,
                });
                setNotice("Saved. Your Vivid is ready to connect.");
              })()
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          />
        </Card>
        <Card>
          <Label size="headline">A little about Vivid</Label>
          <Label tone="ink-3">
            One person, one Vivid. A teammate for the work and life around it.
          </Label>
          <ControlPill label="About this version" onPress={() => setAbout(true)} />
        </Card>
      </ScrollView>
      {about && (
        <Sheet title="Vivid · 0.1.0" onClose={() => setAbout(false)}>
          <Label>A native home for your everyday work.</Label>
          <Label tone="ink-3">
            Conversations, tasks, routines, and your Library connect to your Vivid server. Projects
            and the computer view are previews. Chat attachments, voice, and system push
            notifications are not connected in this version.
          </Label>
          <Label size="label" tone="ink-3">
            Includes components adapted from T3 Code. Copyright © 2026 T3 Tools Inc., MIT License.
          </Label>
        </Sheet>
      )}
    </View>
  );
}
