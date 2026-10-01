import { Workspace, type MeResponse, type Thread, type ThreadId } from '@vivid/contracts'
import { Data, Option, Result } from 'effect'
import { useRef, useState, type RefObject } from 'react'
import { FlatList, ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  FolderKanban,
  Library as LibraryIcon,
  Repeat2,
  Search,
  type LucideIcon,
} from 'lucide-react-native'
import { useNow } from '../data/foreground'
import { arrange, matching, Row, rowKey, rowsOf } from '../data/lanes'
import { LiveState, useLive, useLiveData, useLiveValue } from '../data/live'
import { patchThread, Start, startThread } from '../data/threads'
import type { ComposerEditorHandle } from '../native/composer/types'
import { useTheme } from '../theme'
import { Avatar, pictureOf } from '../ui/Avatar'
import { Composer } from '../ui/Composer'
import { AboveKeyboard } from '../ui/Keyboard'
import { NameSheet } from '../ui/Sheet'
import {
  Button,
  Face,
  Field,
  GUTTER,
  HAIRLINE,
  IconButton,
  Label,
  Notice,
  Press,
  radius,
  Skeleton,
  styles,
  TARGET,
} from '../ui/ui'
import { useGo, useMe, type Routes } from '../workspace'
import { First } from './home/First'
import { ThreadRow } from './home/Row'
import { Switcher } from './home/Switcher'

/**
 * What is open over the list. It is one thing at a time, so the workspace sheet and a Thread
 * being renamed can never be up together.
 */
type Over = Data.TaggedEnum<{
  Nothing: {}
  Switching: {}
  Renaming: { readonly thread: Thread }
}>
const Over = Data.taggedEnum<Over>()

/**
 * Home: every Thread the Person can see, in the order a busy Person should look at them, and at
 * the bottom somewhere to write. It is the root of the app and so the first screen: with no
 * Threads yet it is just Vivid, a few things to say, and the composer.
 *
 * It owns no data. Threads move between lanes because the server says their attention changed;
 * the workspace changes because the Person's session did. What is local is only what the Person
 * is in the middle of: what they have typed, what they are searching for, which sheet is up.
 */
export function Home() {
  const me = useMe()
  const data = useLiveData()
  const go = useGo()
  const threads = useLive(data.live.threads)
  const [over, setOver] = useState<Over>(Over.Nothing())
  const [query, setQuery] = useState<Option.Option<string>>(Option.none())
  const editor = useRef<ComposerEditorHandle>(null)
  const start = useStart(editor)
  const close = () => setOver(Over.Nothing())
  const working =
    LiveState.$is('Ready')(threads) &&
    threads.value.threads.some((thread) => thread.attention === 'Working')

  return (
    <AboveKeyboard>
      <Top
        me={me}
        working={working}
        query={query}
        onQuery={setQuery}
        onSwitch={() => setOver(Over.Switching())}
        onSettings={() => go.navigate('Settings')}
      />
      <View style={{ flex: 1 }}>
        <Listed
          me={me}
          state={threads}
          query={query}
          onOpen={(thread) => go.navigate('Chat', { id: thread.id })}
          onRename={(thread) => setOver(Over.Renaming({ thread }))}
          onSuggest={start.suggest}
        />
      </View>
      {Option.isSome(start.refusal) && (
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
          <Notice message={start.refusal.value} />
        </View>
      )}
      <Composer
        ref={editor}
        value={start.draft}
        placeholder="Message Vivid"
        working={false}
        disabled={start.sending}
        onChange={start.setDraft}
        onSend={() => void start.send()}
        onStop={() => undefined}
      />
      {Over.$is('Switching')(over) && <Switcher me={me} onClose={close} />}
      {Over.$is('Renaming')(over) && <Rename thread={over.thread} onClose={close} />}
    </AboveKeyboard>
  )
}

/**
 * Starting a Thread from the composer at the bottom of Home.
 *
 * The Person is taken to the Thread only once their message is with Vivid, so words they typed
 * are never dropped on the way to a screen that could not say so. If the Thread was made and the
 * message did not arrive, sending again speaks into that Thread instead of making a second one.
 */
function useStart(editor: RefObject<ComposerEditorHandle | null>) {
  const data = useLiveData()
  const go = useGo()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [last, setLast] = useState<Option.Option<Start>>(Option.none())

  /** The empty Thread an earlier attempt left behind, when there is one. */
  const resume = Option.flatMap(last, (outcome) =>
    Start.$is('NotSaid')(outcome) ? Option.some(outcome.id) : Option.none<ThreadId>(),
  )

  async function send() {
    const message = draft.trim()
    if (message.length === 0 || sending) return
    setSending(true)
    const outcome = await startThread(data, { message, projectId: null, resume })
    setSending(false)
    if (Start.$is('Started')(outcome)) {
      setDraft('')
      setLast(Option.none())
      go.navigate('Chat', { id: outcome.id })
      return
    }
    setLast(Option.some(outcome))
  }

  return {
    draft,
    sending,
    setDraft,
    send,
    refusal: Option.flatMap(last, (outcome) =>
      Start.$match(outcome, {
        Started: () => Option.none<string>(),
        NotCreated: ({ message }) => Option.some(message),
        NotSaid: ({ message }) => Option.some(message),
      }),
    ),
    /** Puts a suggestion's words in the composer and the cursor after them. */
    suggest: (text: string) => {
      setDraft(text)
      if (editor.current !== null) editor.current.focus()
    },
  }
}

/** The top of Home: where the Person is working, the way to search, and the way to Settings. */
function Bar({
  me,
  working,
  onSwitch,
  onSearch,
  onSettings,
}: {
  me: MeResponse
  working: boolean
  onSwitch: () => void
  onSearch: () => void
  onSettings: () => void
}) {
  const insets = useSafeAreaInsets()
  const { colors: c } = useTheme()
  const here = Workspace.match(me.workspace, {
    Personal: () => 'Vivid',
    Company: ({ company }) => company.name,
  })
  return (
    <View
      style={{
        paddingTop: insets.top,
        paddingLeft: GUTTER - 8,
        paddingRight: 6,
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 52 + insets.top,
      }}
    >
      <Press
        accessibilityRole="button"
        accessibilityLabel={`Working in ${here}. Change workspace`}
        onPress={onSwitch}
        containerStyle={{ flexShrink: 1 }}
        style={({ pressed }) => ({
          minHeight: TARGET,
          paddingHorizontal: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          borderRadius: radius.control,
          backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
        })}
      >
        <Face size={26} mood={working ? 'thinking' : 'neutral'} />
        <Label numberOfLines={1} size="headline" style={{ flexShrink: 1 }}>
          {here}
        </Label>
        <ChevronsUpDown pointerEvents="none" size={15} strokeWidth={1.8} color={c['ink-4']} />
      </Press>
      <View style={{ flex: 1 }} />
      <IconButton icon={Search} label="Search threads" onPress={onSearch} />
      <Press
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={onSettings}
        style={({ pressed }) => ({
          width: TARGET,
          height: TARGET,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Avatar name={me.person.name} image={pictureOf(me.person)} size={28} />
      </Press>
    </View>
  )
}

/** The bar while searching: the field has the keyboard, and Cancel puts the lanes back. */
function SearchBar({
  text,
  onChange,
  onDone,
}: {
  text: string
  onChange: (text: string) => void
  onDone: () => void
}) {
  const insets = useSafeAreaInsets()
  return (
    <View
      style={{
        paddingTop: insets.top + 4,
        paddingLeft: GUTTER - 4,
        paddingRight: 6,
        paddingBottom: 4,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <Field
        autoFocus
        accessibilityLabel="Search threads"
        value={text}
        placeholder="Search threads"
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        onChangeText={onChange}
        style={{ flex: 1, minHeight: TARGET, paddingVertical: 9 }}
      />
      <Button kind="ghost" label="Cancel" onPress={onDone} />
    </View>
  )
}

/** The three places beside Threads, in the order the web sidebar lists them. */
const PLACES = [
  { route: 'Routines', label: 'Routines', icon: Repeat2 },
  { route: 'Projects', label: 'Projects', icon: FolderKanban },
  { route: 'Library', label: 'Library', icon: LibraryIcon },
] as const satisfies ReadonlyArray<{
  route: Exclude<keyof Routes, 'Home' | 'Chat' | 'Settings'>
  label: string
  icon: LucideIcon
}>

function Places() {
  const go = useGo()
  const { colors: c } = useTheme()
  return (
    <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: GUTTER - 6, paddingBottom: 6 }}>
      {PLACES.map(({ route, label, icon: Icon }) => (
        <Press
          key={route}
          accessibilityRole="button"
          onPress={() => go.navigate(route)}
          containerStyle={{ flex: 1 }}
          style={({ pressed }) => ({
            minHeight: TARGET,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            borderRadius: radius.control,
            borderWidth: HAIRLINE,
            borderColor: c['line-2'],
            backgroundColor: pressed ? c['wash-pressed'] : c['surface-2'],
          })}
        >
          <Icon pointerEvents="none" size={16} strokeWidth={1.7} color={c['ink-2']} />
          <Label numberOfLines={1} size="label" tone="ink-2">
            {label}
          </Label>
        </Press>
      ))}
    </View>
  )
}

/** A lane's heading. Only the two attention lanes say how many they hold. */
function Caption({ label, count }: { label: string; count: Option.Option<number> }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: 6,
        paddingHorizontal: GUTTER,
        paddingTop: 18,
        paddingBottom: 6,
      }}
    >
      <Label accessibilityRole="header" size="label" tone="ink-3" style={{ fontWeight: '500' }}>
        {label}
      </Label>
      {Option.isSome(count) && (
        <Label size="label" tone="ink-4" style={{ fontVariant: ['tabular-nums'] }}>
          {count.value}
        </Label>
      )}
    </View>
  )
}

/** The strip across the top: the workspace and the tools, or the search field while searching. */
function Top({
  me,
  working,
  query,
  onQuery,
  onSwitch,
  onSettings,
}: {
  me: MeResponse
  working: boolean
  query: Option.Option<string>
  onQuery: (query: Option.Option<string>) => void
  onSwitch: () => void
  onSettings: () => void
}) {
  if (Option.isSome(query)) {
    return (
      <SearchBar
        text={query.value}
        onChange={(next) => onQuery(Option.some(next))}
        onDone={() => onQuery(Option.none())}
      />
    )
  }
  return (
    <Bar
      me={me}
      working={working}
      onSwitch={onSwitch}
      onSearch={() => onQuery(Option.some(''))}
      onSettings={onSettings}
    />
  )
}

/** The Threads as they stand: their outline while they load, why they cannot be read, or the list. */
function Listed({
  state,
  ...rest
}: Omit<ThreadsProps, 'threads'> & {
  state: LiveState<{ readonly threads: ReadonlyArray<Thread> }>
}) {
  if (LiveState.$is('Loading')(state)) {
    return (
      <View style={{ paddingHorizontal: GUTTER, paddingTop: 24 }}>
        <Skeleton rows={5} />
      </View>
    )
  }
  if (LiveState.$is('Failed')(state)) {
    return (
      <View style={{ padding: GUTTER }}>
        <Notice message={state.failure.message} />
      </View>
    )
  }
  return <Threads {...rest} threads={state.value.threads} />
}

interface ThreadsProps {
  readonly me: MeResponse
  readonly threads: ReadonlyArray<Thread>
  readonly query: Option.Option<string>
  readonly onOpen: (thread: Thread) => void
  readonly onRename: (thread: Thread) => void
  readonly onSuggest: (text: string) => void
}

/**
 * The list under the bar. While searching it is every Thread that matches, flat. Otherwise it is
 * the lanes: what needs the Person, what Vivid is working on, the rest by day, and what is done
 * on a shelf at the end. With no Threads at all it is the first screen.
 */
function Threads(props: ThreadsProps) {
  const { threads, query } = props
  const now = useNow()
  if (Option.isSome(query)) {
    return <Found {...props} found={matching(threads, query.value)} now={now} />
  }
  if (threads.length === 0) return <Welcome me={props.me} onSuggest={props.onSuggest} />
  const arrangement = arrange(threads, now)
  return (
    <FlatList
      data={rowsOf(arrangement.lanes)}
      keyExtractor={rowKey}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={[styles.column, { paddingBottom: 16 }]}
      ListHeaderComponent={<Places />}
      ListFooterComponent={
        arrangement.archived.length === 0 ? null : (
          <Shelf {...props} done={arrangement.archived} now={now} />
        )
      }
      renderItem={({ item }) =>
        Row.$match(item, {
          Heading: ({ label, count }) => <Caption label={label} count={count} />,
          Entry: ({ thread, variant }) => (
            <ThreadRow
              thread={thread}
              variant={variant}
              now={now}
              onOpen={props.onOpen}
              onRename={props.onRename}
            />
          ),
        })
      }
    />
  )
}

/** The first screen: no Threads yet, so Vivid, things to say, and the three places. */
function Welcome({ me, onSuggest }: { me: MeResponse; onSuggest: (text: string) => void }) {
  const data = useLiveData()
  const suggestions = useLiveValue(data.live.suggestions)
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={[styles.column, { flexGrow: 1 }]}
    >
      <Places />
      <First
        me={me}
        suggestions={Option.match(suggestions, {
          onNone: () => [],
          onSome: (value) => value.suggestions,
        })}
        onChoose={onSuggest}
      />
    </ScrollView>
  )
}

/** What a search found, across current and done Threads alike. */
function Found(props: ThreadsProps & { found: ReadonlyArray<Thread>; now: number }) {
  return (
    <FlatList
      data={props.found}
      keyExtractor={(thread) => thread.id}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={[styles.column, { paddingBottom: 16 }]}
      ListEmptyComponent={
        <Label size="label" tone="ink-3" style={{ paddingHorizontal: GUTTER, paddingTop: 20 }}>
          No thread matches that.
        </Label>
      }
      renderItem={({ item }) => (
        <ThreadRow
          thread={item}
          variant="line"
          now={props.now}
          onOpen={props.onOpen}
          onRename={props.onRename}
        />
      )}
    />
  )
}

/** Threads the Person is done with, kept out of the way behind one row that says how many. */
function Shelf(props: ThreadsProps & { done: ReadonlyArray<Thread>; now: number }) {
  const { colors: c } = useTheme()
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View style={{ marginTop: 12 }}>
      <Press
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((shown) => !shown)}
        style={({ pressed }) => ({
          minHeight: 48,
          paddingHorizontal: GUTTER,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
        })}
      >
        <CircleCheck pointerEvents="none" size={17} strokeWidth={1.7} color={c['ink-3']} />
        <Label tone="ink-2" style={{ flex: 1 }}>
          Done
        </Label>
        <Label size="label" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
          {props.done.length}
        </Label>
        <Chevron pointerEvents="none" size={16} strokeWidth={1.7} color={c['ink-4']} />
      </Press>
      {open &&
        props.done.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            variant="line"
            now={props.now}
            onOpen={props.onOpen}
            onRename={props.onRename}
          />
        ))}
    </View>
  )
}

/** A Thread's title, changed in a sheet. The list shows the new title before the server answers. */
function Rename({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const data = useLiveData()
  return (
    <NameSheet
      title="Rename thread"
      label="Title"
      initial={thread.title}
      placeholder="What this thread is about"
      action="Save"
      maxLength={120}
      onClose={onClose}
      onSave={async (title) => {
        if (title === thread.title) return Option.none()
        const result = await patchThread(data, thread.id, { title })
        return Result.isFailure(result) ? Option.some(result.failure.message) : Option.none()
      }}
    />
  )
}
