import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { AppState, FlatList, KeyboardAvoidingView, Linking, Platform, View } from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { Monitor } from 'lucide-react-native'
import { createFlueClient, type FlueConversationMessage } from '@flue/sdk'
import { useFlueAgent } from '@flue/react'
import { fetch as expoFetch } from 'expo/fetch'
import Markdown from 'react-native-markdown-display'
import { useThreadActivity, useWorkspace, type Routes } from '../workspace'
import { ConnectorRequestCard } from '../components/ConnectorRequestCard'
import {
  readConnectorRequest,
  connectorContinuation,
  type ConnectorRequest,
} from '../../../web/src/data/connectorRequests'
import { TrackedCard } from '../components/TrackedCard'
import { ChatComposer, ChatHeader, useChatKeyboard } from '../components/ChatChrome'
import { openDocument, linkCitations } from '../lib/documents'
import { Card, ControlPill, Empty, Face, Feedback, Label, Sheet, styles } from '../components/ui'
import { nativeMetrics as m } from '@vivid/design-tokens/native'
import { useTheme } from '../theme'
import { deriveCenteredContentHorizontalPadding } from '../lib/layout'

export function Chat(props: NativeStackScreenProps<Routes, 'Chat'>) {
  return <ThreadChat key={props.route.params.id} {...props} />
}

/** Renders the conversation feed while the screen owns Flue and draft state. */
function ChatMessageList({
  list,
  messages,
  width,
  historyReady,
  working,
  sending,
  error,
  connectionError,
  onContinue,
  onRetry,
  onNearBottomChange,
  onContentSizeChange,
}: {
  readonly list: RefObject<FlatList<FlueConversationMessage> | null>
  readonly messages: readonly FlueConversationMessage[]
  readonly width: number
  readonly historyReady: boolean
  readonly working: boolean
  readonly sending: boolean
  readonly error: string
  readonly connectionError: string | null
  readonly onContinue: (text: string) => Promise<void>
  readonly onRetry: () => void
  readonly onNearBottomChange: (nearBottom: boolean) => void
  readonly onContentSizeChange: () => void
}) {
  return (
    <FlatList
      ref={list}
      data={messages}
      keyExtractor={(message) => message.id}
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
        const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent
        onNearBottomChange(
          contentSize.height - layoutMeasurement.height - contentOffset.y < 100,
        )
      }}
      scrollEventThrottle={100}
      onContentSizeChange={onContentSizeChange}
      ListEmptyComponent={
        historyReady ? (
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 18,
              paddingVertical: 60,
            }}
          >
            <Face size={50} />
            <Label style={{ fontSize: 28, lineHeight: 36, letterSpacing: -0.8 }}>
              Hi, I'm Vivid.
            </Label>
            <Label tone="ink-2" style={{ fontWeight: '400' }}>
              What should I take off your plate?
            </Label>
          </View>
        ) : (
          <Feedback loading />
        )
      }
      renderItem={({ item }) => (
        <Message message={item} working={working || sending} onContinue={onContinue} />
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
          <Feedback error={error || connectionError || undefined} retry={onRetry} retryLabel="Reconnect" />
        </View>
      }
    />
  )
}

/** Shows either the work log or the current computer-preview state. */
function ActivitySheet({
  panel,
  messages,
  onClose,
  onOpenScreen,
}: {
  readonly panel: 'log' | 'screen'
  readonly messages: readonly FlueConversationMessage[]
  readonly onClose: () => void
  readonly onOpenScreen: () => void
}) {
  return (
    <Sheet title={panel === 'log' ? 'What Vivid did' : 'Vivid’s screen'} onClose={onClose}>
      {panel === 'log' && (
        <ControlPill icon={Monitor} label="Vivid’s screen" onPress={onOpenScreen} />
      )}
      {panel === 'screen' ? (
        <Empty
          title="A window into the work"
          detail="Computer activity is a preview in this version. Live computer control is not connected yet."
        />
      ) : (
        messages.map((message) => (
          <Card key={message.id}>
            <Label size="label">
              {message.role === 'user'
                ? 'You asked'
                : message.role === 'assistant'
                  ? 'Vivid responded'
                  : 'Conversation update'}
            </Label>
            <Label tone="ink-3" size="label">
              {message.parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
                .slice(0, 600)}
            </Label>
            {message.parts
              .filter((part) => part.type === 'dynamic-tool')
              .map((part) => (
                <View key={part.toolCallId} style={{ gap: 4 }}>
                  <Label size="label">
                    {part.toolName.replaceAll('_', ' ')} · {part.state}
                  </Label>
                  {part.state === 'output-available' && (
                    <Label selectable size="micro" tone="ink-3">
                      {JSON.stringify(part.output, null, 2)}
                    </Label>
                  )}
                </View>
              ))}
          </Card>
        ))
      )}
    </Sheet>
  )
}

/** Keeps Flue client construction tied to the active conversation and API connection. */
function useConversationClient(api: ReturnType<typeof useWorkspace>['api'], id: string) {
  return useMemo(
    () =>
      createFlueClient({
        url: api.agentUrl(id),
        headers: api.headers,
        // SAFETY: expo/fetch exposes the Fetch API signature expected by Flue.
        fetch: expoFetch.bind(globalThis),
      }),
    [api, id],
  )
}

/** Converts Flue connection failures into the stable mobile recovery copy. */
function connectionErrorMessage(message: string) {
  if (!message) return null
  return message.includes('Connection error')
    ? 'Vivid couldn’t connect. Check the server connection and try again.'
    : message.replace(/^direct\([^)]*\) failed: /, '')
}

function ThreadChat({ route, navigation }: NativeStackScreenProps<Routes, 'Chat'>) {
  const { api } = useWorkspace()
  const { report } = useThreadActivity()
  const { id, title } = route.params
  const client = useConversationClient(api, id)
  const agent = useFlueAgent({ client })
  const [draft, setDraft] = useState(route.params.draft ?? '')
  const keyboardVisible = useChatKeyboard()
  const autoSent = useRef(false)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [panel, setPanel] = useState<'log' | 'screen'>()
  const list = useRef<FlatList>(null)
  const nearBottom = useRef(true)
  const [width, setWidth] = useState(390)
  const working = agent.status === 'submitted' || agent.status === 'streaming'
  useEffect(() => {
    report(id, working ? 'working' : agent.error ? 'failed' : undefined)
    return () => report(id, undefined)
  }, [id, working, agent.error, report])
  // App-state subscriptions stay stable while the Effect Event reads the current Flue client.
  const refresh = useEffectEvent(() => agent.refresh())
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh()
    })
    return () => subscription.remove()
  }, [])
  const messages = agent.messages.filter((message) => message.display !== 'hidden')
  const connectionError = connectionErrorMessage(agent.error === undefined ? '' : agent.error.message)
  async function send(continuation?: string) {
    const text = (continuation ?? draft).trim()
    if (!text || sending || working) return
    setSending(true)
    setError('')
    nearBottom.current = true
    try {
      await agent.sendMessage(text)
      if (!continuation) setDraft('')
      const nextTitle = title === 'New conversation' ? text.slice(0, 80) : title
      navigation.setParams({ title: nextTitle, draft: undefined, sendOnOpen: undefined })
      // The accepted message must not be resent if only the sidebar index update fails.
      try {
        await api.request(`/api/conversations/${id}`, 'PUT', {
          title: nextTitle,
          preview: text.slice(0, 500),
          updatedAt: Date.now(),
          archived: false,
        })
      } catch {
        setError('Your message was sent. The conversation list could not update yet.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }
  // A welcome-screen submission opens a real conversation and sends exactly once.
  useEffect(() => {
    if (route.params.sendOnOpen && agent.historyReady && !autoSent.current) {
      autoSent.current = true
      void send()
    }
  })
  return (
    <KeyboardAvoidingView
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1 }}
      behavior="padding"
      enabled={Platform.OS !== 'android' || keyboardVisible}
      keyboardVerticalOffset={0}
    >
      <ChatHeader
        title={title}
        working={working}
        onOpenLog={() => setPanel('log')}
        onOpenScreen={() => setPanel('screen')}
      />
      <ChatMessageList
        list={list}
        messages={messages}
        width={width}
        historyReady={agent.historyReady}
        working={working}
        sending={sending}
        error={error}
        connectionError={connectionError}
        onContinue={send}
        onRetry={() => agent.refresh()}
        onNearBottomChange={(nextNearBottom) => {
          nearBottom.current = nextNearBottom
        }}
        onContentSizeChange={() => {
          if (nearBottom.current) {
            const currentList = list.current
            if (currentList !== null) currentList.scrollToEnd({ animated: false })
          }
        }}
      />
      <ChatComposer
        value={draft}
        onChange={setDraft}
        onSend={() => void send()}
        disabled={sending || !agent.historyReady}
        working={working}
        keyboardVisible={keyboardVisible}
        onStop={() => {
          void client.abort().catch((e) => setError(e.message))
        }}
      />
      {panel && (
        <ActivitySheet
          panel={panel}
          messages={messages}
          onClose={() => setPanel(undefined)}
          onOpenScreen={() => setPanel('screen')}
        />
      )}
    </KeyboardAvoidingView>
  )
}

type DynamicToolPart = Extract<
  FlueConversationMessage['parts'][number],
  { readonly type: 'dynamic-tool' }
>
type ConnectorRequestEntry = { readonly id: string; readonly request: ConnectorRequest }
type ThemeColors = ReturnType<typeof useTheme>['colors']

/** Renders settlement-aware system updates separately from person and Vivid messages. */
function SystemMessage({ text, failed }: { readonly text: string; readonly failed: boolean }) {
  return (
    <Card>
      <Label size="label" tone="ink-3">
        {failed ? 'Vivid could not complete that response. ' : ''}
        {text}
      </Label>
    </Card>
  )
}

/** Renders user text or Vivid Markdown while preserving authenticated citation handling. */
function MessageText({
  user,
  text,
  colors: c,
  api,
  onLinkError,
}: {
  readonly user: boolean
  readonly text: string
  readonly colors: ThemeColors
  readonly api: ReturnType<typeof useWorkspace>['api']
  readonly onLinkError: (message: string) => void
}) {
  if (user) return <Label selectable>{text}</Label>
  return (
    <Markdown
      onLinkPress={(url) => {
        if (url.startsWith('https://vivid-library.invalid/source?')) {
          const name = new URL(url).searchParams.get('name')
          if (name)
            void openDocument(
              api,
              `/api/library/source?name=${encodeURIComponent(name)}`,
              name,
            ).catch((error) => onLinkError(error.message))
        } else if (/^https?:\/\//i.test(url))
          void Linking.openURL(url).catch(() => onLinkError('Could not open this link.'))
        return false
      }}
      style={{
        body: { color: c.ink, fontSize: m['type-body'], lineHeight: 23 },
        paragraph: { marginTop: 0, marginBottom: 12 },
        code_inline: { backgroundColor: c['surface-2'], color: c.ink },
        fence: {
          backgroundColor: c['surface-well'],
          color: c.ink,
          borderColor: c['line-2'],
        },
        link: { color: c['accent-ink'] },
        blockquote: {
          backgroundColor: c['surface-2'],
          borderColor: c['line-3'],
        },
        table: { borderColor: c['line-2'] },
        tr: { borderColor: c['line-2'] },
      }}
    >
      {linkCitations(text)}
    </Markdown>
  )
}

/** Renders typed tool results below the message that produced them. */
function MessageTools({
  tracked,
  connectorRequests,
  working,
  onContinue,
}: {
  readonly tracked: readonly DynamicToolPart[]
  readonly connectorRequests: readonly ConnectorRequestEntry[]
  readonly working: boolean
  readonly onContinue: (text: string) => Promise<void>
}) {
  return (
    <>
      {tracked.map((tool) => (
        <TrackedCard
          key={tool.toolCallId}
          kind={tool.toolName}
          output={tool.state === 'output-available' ? tool.output : undefined}
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
    </>
  )
}

/** Preserves message geometry while delegating content and tool rendering. */
function ConversationMessage({
  user,
  text,
  colors: c,
  api,
  linkError,
  onLinkError,
  tracked,
  connectorRequests,
  working,
  onContinue,
  time,
}: {
  readonly user: boolean
  readonly text: string
  readonly colors: ThemeColors
  readonly api: ReturnType<typeof useWorkspace>['api']
  readonly linkError: string
  readonly onLinkError: (message: string) => void
  readonly tracked: readonly DynamicToolPart[]
  readonly connectorRequests: readonly ConnectorRequestEntry[]
  readonly working: boolean
  readonly onContinue: (text: string) => Promise<void>
  readonly time: string
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 12,
        alignItems: 'flex-start',
        justifyContent: user ? 'flex-end' : 'flex-start',
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
          maxWidth: user ? '78%' : undefined,
          padding: user ? 14 : 0,
          borderRadius: m['radius-panel'] * m['phone-radius-factor'],
          borderBottomRightRadius:
            (user ? m['radius-sm'] : m['radius-panel']) * m['phone-radius-factor'],
          backgroundColor: user ? c['surface-2'] : undefined,
        }}
      >
        <MessageText user={user} text={text} colors={c} api={api} onLinkError={onLinkError} />
        {!!linkError && (
          <Label size="label" tone="status-danger">
            {linkError}
          </Label>
        )}
        <MessageTools
          tracked={tracked}
          connectorRequests={connectorRequests}
          working={working}
          onContinue={onContinue}
        />
        {!!time && (
          <Label
            size="micro"
            tone="ink-4"
            style={{ marginTop: 4, textAlign: user ? 'right' : 'left' }}
          >
            {time}
          </Label>
        )}
      </View>
    </View>
  )
}

function Message({
  message,
  working,
  onContinue,
}: {
  message: FlueConversationMessage
  working: boolean
  onContinue: (text: string) => Promise<void>
}) {
  const { colors: c } = useTheme()
  const { api } = useWorkspace()
  const [linkError, setLinkError] = useState('')
  const text = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
  const tools = message.parts.filter((p) => p.type === 'dynamic-tool')
  const user = message.role === 'user'
  const settlement = message.settlement
  const metadata = message.metadata
  const tracked = tools.filter(
    (tool) =>
      tool.state === 'output-available' &&
      (tool.toolName === 'create_task' || tool.toolName === 'schedule_follow_up'),
  )
  const connectorRequests = tools.flatMap((tool) => {
    if (tool.toolName !== 'suggest_connector' || tool.state !== 'output-available') return []
    const request = readConnectorRequest(tool.output)
    return request ? [{ id: tool.toolCallId, request }] : []
  })
  if (!text && !tracked.length && !connectorRequests.length) return null
  if (message.role === 'system') {
    return (
      <SystemMessage
        text={text}
        failed={settlement !== undefined && settlement.outcome === 'failed'}
      />
    )
  }
  const rawTimestamp =
    metadata === undefined ? undefined : (metadata.finishedAt ?? metadata.startedAt)
  const timestamp = rawTimestamp == null ? undefined : Number(rawTimestamp)
  const time =
    timestamp === undefined || !Number.isFinite(timestamp)
      ? ''
      : new Date(timestamp).toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        })
  return (
    <ConversationMessage
      user={user}
      text={text}
      colors={c}
      api={api}
      linkError={linkError}
      onLinkError={setLinkError}
      tracked={tracked}
      connectorRequests={connectorRequests}
      working={working}
      onContinue={onContinue}
      time={time}
    />
  )
}
