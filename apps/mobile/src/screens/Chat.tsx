import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { AppState, FlatList, KeyboardAvoidingView, Linking, Platform, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Monitor } from "lucide-react-native";
import { createFlueClient, type FlueConversationMessage } from "@flue/sdk";
import { useFlueAgent } from "@flue/react";
import { fetch as expoFetch } from "expo/fetch";
import Markdown from "react-native-markdown-display";
import { useThreadActivity, useWorkspace, type Routes } from "../workspace";
import { ConnectorRequestCard } from "../components/ConnectorRequestCard";
import {
  readConnectorRequest,
  connectorContinuation,
} from "../../../web/src/data/connectorRequests";
import { TrackedCard } from "../components/TrackedCard";
import { ChatComposer, ChatHeader, useChatKeyboard } from "../components/ChatChrome";
import { openDocument, linkCitations } from "../lib/documents";
import { Card, ControlPill, Empty, Face, Feedback, Label, Sheet, styles } from "../components/ui";
import { nativeMetrics as m } from "@vivid/design-tokens/native";
import { useTheme } from "../theme";
import { deriveCenteredContentHorizontalPadding } from "../lib/layout";

export function Chat(props: NativeStackScreenProps<Routes, "Chat">) {
  return <ThreadChat key={props.route.params.id} {...props} />;
}
function ThreadChat({ route, navigation }: NativeStackScreenProps<Routes, "Chat">) {
  const { api } = useWorkspace();
  const { report } = useThreadActivity();
  const { id, title } = route.params;
  const client = useMemo(
    () =>
      createFlueClient({
        url: api.agentUrl(id),
        headers: api.headers,
        fetch: expoFetch.bind(globalThis) as typeof fetch,
      }),
    [api, id],
  );
  const agent = useFlueAgent({ client });
  const [draft, setDraft] = useState(route.params.draft ?? "");
  const keyboardVisible = useChatKeyboard();
  const autoSent = useRef(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [panel, setPanel] = useState<"log" | "screen">();
  const list = useRef<FlatList>(null);
  const nearBottom = useRef(true);
  const [width, setWidth] = useState(390);
  const working = agent.status === "submitted" || agent.status === "streaming";
  useEffect(() => {
    report(id, working ? "working" : agent.error ? "failed" : undefined);
    return () => report(id, undefined);
  }, [id, working, agent.error, report]);
  // App-state subscriptions stay stable while the Effect Event reads the current Flue client.
  const refresh = useEffectEvent(() => agent.refresh());
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, []);
  const messages = agent.messages.filter((message) => message.display !== "hidden");
  async function send(continuation?: string) {
    const text = (continuation ?? draft).trim();
    if (!text || sending || working) return;
    setSending(true);
    setError("");
    nearBottom.current = true;
    try {
      await agent.sendMessage(text);
      if (!continuation) setDraft("");
      const nextTitle = title === "New conversation" ? text.slice(0, 80) : title;
      navigation.setParams({ title: nextTitle, draft: undefined, sendOnOpen: undefined });
      // The accepted message must not be resent if only the sidebar index update fails.
      try {
        await api.request(`/api/conversations/${id}`, "PUT", {
          title: nextTitle,
          preview: text.slice(0, 500),
          updatedAt: Date.now(),
          archived: false,
        });
      } catch {
        setError("Your message was sent. The conversation list could not update yet.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  // A welcome-screen submission opens a real conversation and sends exactly once.
  useEffect(() => {
    if (route.params.sendOnOpen && agent.historyReady && !autoSent.current) {
      autoSent.current = true;
      void send();
    }
  });
  return (
    <KeyboardAvoidingView
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1 }}
      behavior="padding"
      enabled={Platform.OS !== "android" || keyboardVisible}
      keyboardVerticalOffset={0}
    >
      <ChatHeader
        title={title}
        working={working}
        onOpenLog={() => setPanel("log")}
        onOpenScreen={() => setPanel("screen")}
      />
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(m) => m.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          gap: 24,
          paddingVertical: 24,
          paddingHorizontal: deriveCenteredContentHorizontalPadding({
            viewportWidth: width,
            maxContentWidth: 760,
            minimumPadding: 20,
          }),
          flexGrow: 1,
        }}
        onScroll={(event) => {
          const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
          nearBottom.current =
            contentSize.height - layoutMeasurement.height - contentOffset.y < 100;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (nearBottom.current) list.current?.scrollToEnd({ animated: false });
        }}
        ListEmptyComponent={
          agent.historyReady ? (
            <View
              style={{
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
                gap: 18,
                paddingVertical: 60,
              }}
            >
              <Face size={50} />
              <Label style={{ fontSize: 28, lineHeight: 36, letterSpacing: -0.8 }}>
                Hi, I'm Vivid.
              </Label>
              <Label tone="ink-2" style={{ fontWeight: "400" }}>
                What should I take off your plate?
              </Label>
            </View>
          ) : (
            <Feedback loading />
          )
        }
        renderItem={({ item }) => (
          <Message message={item} working={working || sending} onContinue={send} />
        )}
        ListFooterComponent={
          <View style={{ gap: 12 }}>
            {working && (
              <View style={styles.row}>
                <Face size={24} />
                <Label size="footnote" tone="ink-3">
                  Working on it…
                </Label>
              </View>
            )}
            <Feedback
              error={
                error ||
                (agent.error?.message?.includes("Connection error")
                  ? "Vivid couldn’t connect. Check the server connection and try again."
                  : agent.error?.message?.replace(/^direct\([^)]*\) failed: /, ""))
              }
              retry={() => agent.refresh()}
              retryLabel="Reconnect"
            />
          </View>
        }
      />
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        disabled={sending || !agent.historyReady}
        working={working}
        keyboardVisible={keyboardVisible}
        onStop={() => {
          void client.abort().catch((e) => setError(e.message));
        }}
      />
      {panel && (
        <Sheet
          title={panel === "log" ? "What Vivid did" : "Vivid’s screen"}
          onClose={() => setPanel(undefined)}
        >
          {panel === "log" && (
            <ControlPill icon={Monitor} label="Vivid’s screen" onPress={() => setPanel("screen")} />
          )}
          {panel === "screen" ? (
            <Empty
              title="A window into the work"
              detail="Computer activity is a preview in this version. Live computer control is not connected yet."
            />
          ) : (
            messages.map((message) => (
              <Card key={message.id}>
                <Label size="label">
                  {message.role === "user"
                    ? "You asked"
                    : message.role === "assistant"
                      ? "Vivid responded"
                      : "Conversation update"}
                </Label>
                <Label tone="ink-3" size="label">
                  {message.parts
                    .filter((p) => p.type === "text")
                    .map((p) => p.text)
                    .join("\n")
                    .slice(0, 600)}
                </Label>
                {message.parts
                  .filter((p) => p.type === "dynamic-tool")
                  .map((p) => (
                    <View key={p.toolCallId} style={{ gap: 4 }}>
                      <Label size="label">
                        {p.toolName.replaceAll("_", " ")} · {p.state}
                      </Label>
                      {p.state === "output-available" && (
                        <Label selectable size="micro" tone="ink-3">
                          {JSON.stringify(p.output, null, 2)}
                        </Label>
                      )}
                    </View>
                  ))}
              </Card>
            ))
          )}
        </Sheet>
      )}
    </KeyboardAvoidingView>
  );
}
function Message({
  message,
  working,
  onContinue,
}: {
  message: FlueConversationMessage;
  working: boolean;
  onContinue: (text: string) => Promise<void>;
}) {
  const { colors: c } = useTheme();
  const { api } = useWorkspace();
  const [linkError, setLinkError] = useState("");
  const text = message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  const tools = message.parts.filter((p) => p.type === "dynamic-tool");
  const user = message.role === "user";
  const tracked = tools.filter(
    (tool) =>
      tool.state === "output-available" &&
      (tool.toolName === "create_task" || tool.toolName === "schedule_follow_up"),
  );
  const connectorRequests = tools.flatMap((tool) => {
    if (tool.toolName !== "suggest_connector" || tool.state !== "output-available") return [];
    const request = readConnectorRequest(tool.output);
    return request ? [{ id: tool.toolCallId, request }] : [];
  });
  if (!text && !tracked.length && !connectorRequests.length) return null;
  if (message.role === "system")
    return (
      <Card>
        <Label size="label" tone="ink-3">
          {message.settlement?.outcome === "failed"
            ? "Vivid could not complete that response. "
            : ""}
          {text}
        </Label>
      </Card>
    );
  const timestamp = message.metadata?.finishedAt ?? message.metadata?.startedAt;
  const time =
    typeof timestamp === "number"
      ? new Date(timestamp).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 12,
        alignItems: "flex-start",
        justifyContent: user ? "flex-end" : "flex-start",
      }}
    >
      {!user && (
        <View style={{ marginTop: 4 }}>
          <Face size={24} />
        </View>
      )}
      <View
        style={{
          flexShrink: 1,
          flexGrow: user ? 0 : 1,
          minWidth: 0,
          maxWidth: user ? "78%" : undefined,
          padding: user ? 14 : 0,
          borderRadius: m["radius-panel"] * m["phone-radius-factor"],
          borderBottomRightRadius:
            (user ? m["radius-sm"] : m["radius-panel"]) * m["phone-radius-factor"],
          backgroundColor: user ? c["surface-2"] : undefined,
        }}
      >
        {user ? (
          <Label selectable>{text}</Label>
        ) : (
          <Markdown
            onLinkPress={(url) => {
              if (url.startsWith("https://vivid-library.invalid/source?")) {
                const name = new URL(url).searchParams.get("name");
                if (name)
                  void openDocument(
                    api,
                    `/api/library/source?name=${encodeURIComponent(name)}`,
                    name,
                  ).catch((e) => setLinkError(e.message));
              } else if (/^https?:\/\//i.test(url))
                void Linking.openURL(url).catch(() => setLinkError("Could not open this link."));
              return false;
            }}
            style={{
              body: { color: c.ink, fontSize: m["type-body"], lineHeight: 23 },
              paragraph: { marginTop: 0, marginBottom: 12 },
              code_inline: { backgroundColor: c["surface-2"], color: c.ink },
              fence: {
                backgroundColor: c["surface-well"],
                color: c.ink,
                borderColor: c["line-2"],
              },
              link: { color: c["accent-ink"] },
              blockquote: {
                backgroundColor: c["surface-2"],
                borderColor: c["line-3"],
              },
              table: { borderColor: c["line-2"] },
              tr: { borderColor: c["line-2"] },
            }}
          >
            {linkCitations(text)}
          </Markdown>
        )}
        {!!linkError && (
          <Label size="label" tone="status-danger">
            {linkError}
          </Label>
        )}
        {tracked.map((tool) => (
          <TrackedCard
            key={tool.toolCallId}
            kind={tool.toolName}
            output={tool.state === "output-available" ? tool.output : undefined}
          />
        ))}
        {connectorRequests.map(({ id, request }) => (
          <ConnectorRequestCard
            key={id}
            request={request}
            disabled={working}
            onContinue={() => onContinue(connectorContinuation(request.connector))}
          />
        ))}
        {!!time && (
          <Label
            size="micro"
            tone="ink-4"
            style={{ marginTop: 4, textAlign: user ? "right" : "left" }}
          >
            {time}
          </Label>
        )}
      </View>
    </View>
  );
}
