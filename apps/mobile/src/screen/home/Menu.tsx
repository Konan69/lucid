import {
  mayChangeAppearance,
  Workspace,
  type MeResponse,
  type Project,
  type ProjectId,
  type Thread,
} from '@vivid/contracts'
import { projects } from '@vivid/state'
import { Option } from 'effect'
import { useRef, useState, type ReactNode } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Bell,
  ChevronsUpDown,
  Plus,
  Library as LibraryIcon,
  Search,
  Settings as SettingsIcon,
  SquarePen,
  X,
  type LucideIcon,
} from 'lucide-react-native'
import { collapseAt, RESTING } from '../../data/collapse'
import { useKeyboardShowing } from '../../data/keyboard'
import { LiveState, useLive, useLiveData } from '../../data/live'
import { MOBILE_TYPOGRAPHY } from '../../data/typography'
import { useAppearance } from '../../data/vivid'
import { useTheme } from '../../theme'
import { Avatar, pictureOf } from '../../ui/Avatar'
import { Face } from '../../ui/Face'
import { Glass } from '../../ui/Glass'
import { APPEAR, LEAVE, MORPH } from '../../ui/motion/morph'
import { EDGE, GUTTER, IconButton, Label, Notice, Press, radius, TARGET } from '../../ui/ui'
import type { Routes } from '../../workspace'
import { ScopeChip } from '../project/Chip'
import { CreateProject } from '../project/Create'
import { Mark } from '../project/Mark'
import { scope, useScope } from '../project/scope'
import { Customise } from '../vivid/Customise'
import { Threads } from './Threads'

/** Where the drawer can send the Person that needs nothing said about it: a place, by its name. */
export type Place = {
  [Name in keyof Routes]: undefined extends Routes[Name] ? Name : never
}[keyof Routes]

/**
 * The places beside Threads. Projects is not one of them: a Project is work, not a place, so
 * Projects are a group of rows above the Threads (`Group`), each with its own colour.
 * Skills is not one either: a Person never manages skills. Vivid saves and reuses its own
 * procedures, so there is no Skills screen on any surface.
 */
const PLACES = [
  { route: 'Library', label: 'Library', icon: LibraryIcon },
] as const satisfies ReadonlyArray<{ route: Place; label: string; icon: LucideIcon }>

/** One line of the drawer that goes somewhere: a mark, a name, and at most one thing after it. */
function Line({
  icon: Icon,
  leading,
  label,
  accessibilityLabel,
  trailing,
  selected = false,
  tone = 'ink',
  iconColor,
  onPress,
}: {
  icon?: LucideIcon
  /** Stands where the icon would, when the line is a Person and not a place. */
  leading?: ReactNode
  label: string
  accessibilityLabel?: string
  trailing?: ReactNode
  /** The row the drawer is scoped to: it keeps the pressed fill while it is the one chosen. */
  selected?: boolean
  /** A quieter ink, for a row that is a way to make something and not a thing itself. */
  tone?: 'ink' | 'ink-3'
  iconColor?: string
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 46,
        marginHorizontal: GUTTER - 12,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: radius.row,
        backgroundColor: pressed || selected ? c['row-hover'] : 'transparent',
      })}
    >
      {Icon !== undefined && (
        <Icon
          pointerEvents="none"
          size={19}
          strokeWidth={1.7}
          color={iconColor === undefined ? c.foreground : iconColor}
        />
      )}
      {leading}
      <Label numberOfLines={1} tone={tone} style={{ flex: 1 }}>
        {label}
      </Label>
      {trailing}
    </Press>
  )
}

/** More Projects than this and the drawer would be all Projects; the rest are one row away. */
const SHOWN = 6

/**
 * Projects, above the Threads: each one a row with its own colour and, when any of its Threads
 * is waiting on the Person, how many. Tapping one scopes the drawer to it and opens its page.
 * The group ends with the quiet way to make another; with no Projects it is that one row and
 * nothing else, with no heading over a list of nothing.
 *
 * The grouping is T3 Code mobile's drawer, which lists Threads under their project
 * (`features/threads/ThreadNavigationSidebar.tsx`), and ChatGPT's "Projects" group above the
 * recent conversations. Vivid's Threads are ordered by what needs the Person, so here the
 * Projects are a group of their own above that order instead of headings inside it.
 */
function Group({
  all,
  threads,
  scoped,
  onProject,
  onAll,
  onCreate,
}: {
  all: ReadonlyArray<Project>
  /** Every Thread the Person can see, unscoped: a Project's count does not depend on the scope. */
  threads: ReadonlyArray<Thread>
  scoped: Option.Option<ProjectId>
  onProject: (id: ProjectId) => void
  onAll: () => void
  onCreate: () => void
}) {
  const { colors: c } = useTheme()
  const top = projects.projectsIn(all, null)
  const shown = top.slice(0, SHOWN)
  const more = top.length - shown.length
  return (
    <View style={{ paddingTop: 10 }}>
      {top.length > 0 && (
        <Label
          accessibilityRole="header"
          size="caption"
          tone="drawer-foreground-muted"
          style={{ fontWeight: '600', paddingHorizontal: GUTTER, paddingTop: 8, paddingBottom: 6 }}
        >
          Projects
        </Label>
      )}
      {shown.map((project) => {
        const needing = projects.needingYou(threads, project.id)
        return (
          <Line
            key={project.id}
            leading={
              <View style={{ width: 19, alignItems: 'center' }}>
                <Mark id={project.id} />
              </View>
            }
            label={project.name}
            accessibilityLabel={
              needing > 0 ? `${project.name}. ${needing} waiting for you` : project.name
            }
            selected={Option.contains(scoped, project.id)}
            trailing={
              needing > 0 ? (
                <Label
                  size="label"
                  tone="status-attention"
                  style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}
                >
                  {needing}
                </Label>
              ) : undefined
            }
            onPress={() => onProject(project.id)}
          />
        )
      })}
      {more > 0 && (
        <Line
          leading={<View style={{ width: 19 }} />}
          label={`${more} more`}
          tone="ink-3"
          onPress={onAll}
        />
      )}
      <Line
        icon={Plus}
        label="New project"
        tone="ink-3"
        iconColor={c['foreground-secondary']}
        onPress={onCreate}
      />
    </View>
  )
}

/** The height of the two controls at the foot of the list, and so the diameter of the round one. */
const ACTION = 56

/**
 * The way to a new Thread: its mark and its words at rest, the mark alone while the list is
 * moving down under it, so it never covers the row being read.
 *
 * The behaviour is T3 Code mobile's Android home button
 * (`src/components/MaterialFloatingActionButton.android.tsx`, driven by
 * `src/features/home/material-fab-scroll.ts`): extended at rest, collapsed while scrolling. The
 * reference draws a Compose button through `@expo/ui`; Vivid draws its own pill on both
 * platforms and changes its width with a layout transition, which needs no new native module.
 */
function Fresh({ expanded, onPress }: { expanded: boolean; onPress: () => void }) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel="New thread"
      onPress={onPress}
      layout={MORPH}
    >
      <Glass radius={ACTION / 2} style={{ backgroundColor: c.primary, borderColor: c.primary }}>
        <View
          style={{
            height: ACTION,
            minWidth: ACTION,
            paddingHorizontal: expanded ? 20 : 0,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            backgroundColor: c.primary,
          }}
        >
          <SquarePen
            pointerEvents="none"
            size={20}
            strokeWidth={1.9}
            color={c['primary-foreground']}
          />
          {expanded && (
            <Animated.View entering={APPEAR} exiting={LEAVE}>
              <Label size="footnote" tone="ink-on-accent" style={{ fontWeight: '600' }}>
                New thread
              </Label>
            </Animated.View>
          )}
        </View>
      </Glass>
    </Press>
  )
}

/**
 * Search, in the thumb zone. At rest it is one round button beside "New thread". Tapped, it
 * grows across the foot of the drawer into a field with the keyboard under it, and the list
 * above filters as it is typed; its cross puts the list and the button back.
 *
 * It was a field at the top of the drawer, which a thumb cannot reach on a tall phone. The
 * change of shape is one layout transition (`MORPH`, the reference's 200 ms ease-out), so the
 * button is seen to become the field instead of one replacing the other.
 */
function Seek({
  query,
  onChange,
}: {
  /** What is being searched for; none while search is only its button. */
  query: Option.Option<string>
  onChange: (query: Option.Option<string>) => void
}) {
  const { colors: c } = useTheme()
  return (
    <Animated.View layout={MORPH} style={Option.isSome(query) ? { flex: 1 } : { width: ACTION }}>
      <Glass radius={ACTION / 2}>
        {Option.isSome(query) ? (
          <View
            style={{
              height: ACTION,
              paddingLeft: 18,
              paddingRight: 6,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Search
              pointerEvents="none"
              size={18}
              strokeWidth={1.9}
              color={c['foreground-secondary']}
            />
            <TextInput
              autoFocus
              accessibilityLabel="Search threads"
              value={query.value}
              placeholder="Search threads"
              placeholderTextColor={c.placeholder}
              selectionColor={c.primary}
              autoCorrect={false}
              returnKeyType="search"
              onChangeText={(next) => onChange(Option.some(next))}
              style={[
                { flex: 1, paddingVertical: 0, color: c.foreground },
                MOBILE_TYPOGRAPHY.typing,
              ]}
            />
            <IconButton icon={X} label="Stop searching" onPress={() => onChange(Option.none())} />
          </View>
        ) : (
          <Press
            accessibilityRole="button"
            accessibilityLabel="Search threads"
            onPress={() => onChange(Option.some(''))}
            style={({ pressed }) => ({
              height: ACTION,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? c['row-hover'] : 'transparent',
            })}
          >
            <Search pointerEvents="none" size={20} strokeWidth={1.9} color={c.foreground} />
          </Press>
        )}
      </Glass>
    </Animated.View>
  )
}

/**
 * The foot of the drawer: the Person, who is also the way to change workspace, and Settings. It
 * is hidden while the keyboard is up so searching has the room.
 */
function Foot({
  me,
  here,
  onSwitch,
  onGo,
}: {
  me: MeResponse
  /** The workspace's name, said in the row's label for a screen reader. */
  here: string
  onSwitch: () => void
  onGo: (place: Place) => void
}) {
  const insets = useSafeAreaInsets()
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderTopWidth: EDGE,
        borderTopColor: c['border-subtle'],
        paddingTop: 6,
        paddingRight: 6,
        paddingBottom: Math.max(insets.bottom, 8),
      }}
    >
      <View style={{ flex: 1 }}>
        <Line
          leading={<Avatar name={me.person.name} image={pictureOf(me.person)} size={28} />}
          label={me.person.name}
          accessibilityLabel={`${me.person.name}, working in ${here}. Change workspace`}
          onPress={onSwitch}
          trailing={
            <ChevronsUpDown pointerEvents="none" size={15} strokeWidth={1.8} color={c.chevron} />
          }
        />
      </View>
      <IconButton icon={SettingsIcon} label="Settings" onPress={() => onGo('Settings')} />
    </View>
  )
}

/**
 * The drawer's Threads as they are listed: the scoped Project's when there is a scope, every
 * Thread otherwise. While either answer is still on its way the Threads' own state stands.
 */
function scopedThreads(
  threads: LiveState<{ readonly threads: ReadonlyArray<Thread> }>,
  filed: LiveState<{ readonly projects: ReadonlyArray<Project> }>,
  scoped: Option.Option<ProjectId>,
): LiveState<{ readonly threads: ReadonlyArray<Thread> }> {
  if (!LiveState.$is('Ready')(threads) || !LiveState.$is('Ready')(filed)) return threads
  return LiveState.Ready({
    value: { threads: projects.scopedTo(threads.value.threads, filed.value.projects, scoped) },
  })
}

/**
 * The top of the drawer: Vivid's face beside where the Person is, and the scope beside that
 * while there is one. For someone who may change Vivid here the face and name are the way in to
 * the Customise sheet; for a member of a Company they are only a heading.
 */
function Head({
  me,
  here,
  scoped,
  onProject,
}: {
  me: MeResponse
  here: string
  scoped: Option.Option<Project>
  onProject: (id: ProjectId) => void
}) {
  const editable = mayChangeAppearance(me.workspace)
  const [customising, setCustomising] = useState(false)
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingRight: GUTTER - 4,
        paddingBottom: 6,
      }}
    >
      <Press
        accessibilityRole={editable ? 'button' : 'header'}
        accessibilityLabel={editable ? `${here}. Customise Vivid` : here}
        disabled={!editable}
        onPress={() => setCustomising(true)}
        // The name gives way to the chip: where the Person is narrowed to is the newer fact.
        containerStyle={{ flexShrink: 1, minWidth: 96 }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: TARGET,
          paddingLeft: GUTTER,
        }}
      >
        <Face size={28} label="" />
        <Label numberOfLines={1} size="heading" style={{ flexShrink: 1 }}>
          {here}
        </Label>
      </Press>
      {/* Pushed to the trailing edge, so the name and the scope read as two separate facts. */}
      <View style={{ flex: 1 }} />
      {Option.isSome(scoped) && (
        <Animated.View entering={APPEAR} exiting={LEAVE} style={{ flexShrink: 1 }}>
          <ScopeChip project={scoped.value} onOpen={() => onProject(scoped.value.id)} />
        </Animated.View>
      )}
      {customising && <Customise onClose={() => setCustomising(false)} />}
    </View>
  )
}

/**
 * How the drawer writes what is unread. It is the server's count of everything unread, which has
 * no ceiling, so it is written the way the Person's own locale writes a number ("1,284").
 */
const count = new Intl.NumberFormat()

/**
 * The way to Notifications, first among the places because it is the one that changes while the
 * Person is away. What is unread is counted at its trailing edge, in the ink and the place a
 * Project's waiting Threads are counted (`Group`), so the drawer has one way of saying "this
 * many things want you". It reads the live query itself, so only this line redraws when a
 * notice arrives.
 */
function NotificationsLine({ onOpen }: { onOpen: () => void }) {
  const data = useLiveData()
  const state = useLive(data.live.notifications)
  const unread = LiveState.$is('Ready')(state) ? state.value.unreadCount : 0
  return (
    <Line
      icon={Bell}
      label="Notifications"
      accessibilityLabel={
        unread > 0 ? `Notifications. ${count.format(unread)} unread` : 'Notifications'
      }
      trailing={
        unread > 0 ? (
          <Label
            size="label"
            tone="status-attention"
            style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}
          >
            {count.format(unread)}
          </Label>
        ) : undefined
      }
      onPress={onOpen}
    />
  )
}

/**
 * What scrolls above the Threads: the places beside them, then the Projects. It owns the sheet
 * that names a new Project, since that is asked for from here.
 */
function Beside({
  all,
  threads,
  scoped,
  onGo,
  onProject,
}: {
  all: LiveState<{ readonly projects: ReadonlyArray<Project> }>
  threads: LiveState<{ readonly threads: ReadonlyArray<Thread> }>
  scoped: Option.Option<ProjectId>
  onGo: (place: Place) => void
  onProject: (id: ProjectId) => void
}) {
  const [creating, setCreating] = useState(false)
  /** Going to a Project is scoping to it: the drawer narrows and its page opens. */
  const openProject = (id: ProjectId) => {
    scope.enter(id)
    onProject(id)
  }
  return (
    <View style={{ paddingBottom: 4 }}>
      <NotificationsLine onOpen={() => onGo('Notifications')} />
      {PLACES.map(({ route, label, icon }) => (
        <Line key={route} icon={icon} label={label} onPress={() => onGo(route)} />
      ))}
      {/* Drawn once the Projects are known: a group that arrived late would push every Thread
          down under the Person's thumb. */}
      {LiveState.$is('Ready')(all) && (
        <Group
          all={all.value.projects}
          threads={LiveState.$is('Ready')(threads) ? threads.value.threads : []}
          scoped={scoped}
          onProject={openProject}
          onAll={() => onGo('Projects')}
          onCreate={() => setCreating(true)}
        />
      )}
      {creating && (
        <CreateProject
          inside={null}
          onMade={(project) => openProject(project.id)}
          onClose={() => setCreating(false)}
        />
      )}
    </View>
  )
}

/**
 * The drawer's contents, laid out for a thumb. The top is a title: where the Person is working, and
 * the Project they have narrowed to while there is one. Everything pressed is from the middle down: the places, the Threads, then
 * search and "New thread" floating over the foot of the list, and under them the Person, which
 * is the way to another workspace, beside the way to Settings.
 *
 * It owns only what the Person is in the middle of here: what they are searching for and whether
 * the list is moving. Everything it shows is read live, and every action is handed in by Home,
 * which owns the sheets those actions open.
 */
export function Menu({
  me,
  width,
  refused,
  onSwitch,
  onFresh,
  onGo,
  onProject,
  onOpen,
  onRename,
  onFile,
  onRefused,
}: {
  me: MeResponse
  width: number
  /** A row's quick action that the server refused, said above the list. */
  refused: Option.Option<string>
  onSwitch: () => void
  onFresh: () => void
  /** Goes to a place on the stack. Home closes the drawer behind it. */
  onGo: (place: Place) => void
  onProject: (id: ProjectId) => void
  onOpen: (thread: Thread) => void
  onRename: (thread: Thread) => void
  onFile: (thread: Thread) => void
  onRefused: (message: Option.Option<string>) => void
}) {
  const data = useLiveData()
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardShowing()
  const threads = useLive(data.live.threads)
  const filed = useLive(data.live.projects)
  const scoped = useScope()
  const scopedId = Option.map(scoped, (project) => project.id)
  const listed = scopedThreads(threads, filed, scopedId)
  const [query, setQuery] = useState<Option.Option<string>>(Option.none())
  // The scroll position is tracked in a ref: only the moment the button changes shape is state,
  // so a moving list renders nothing.
  const scroll = useRef(RESTING)
  const [expanded, setExpanded] = useState(true)
  // In a personal space the drawer is headed by Vivid itself, under the name the Person gave it.
  const vivid = useAppearance()
  const here = Workspace.match(me.workspace, {
    Personal: () => vivid.name,
    Company: ({ company }) => company.name,
  })

  function scrolled({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) {
    const furthest = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height
    scroll.current = collapseAt(scroll.current, nativeEvent.contentOffset.y, furthest)
    if (scroll.current.expanded !== expanded) setExpanded(scroll.current.expanded)
  }

  return (
    // The search field has to stay above the keyboard. The drawer is outside Home's own
    // keyboard-avoiding view, so it has one of its own, on the rule `ui/Keyboard.tsx` verified
    // on a device: Android pads only while the keyboard is up.
    <KeyboardAvoidingView
      behavior="padding"
      enabled={Platform.OS !== 'android' || keyboard}
      style={{ flex: 1, paddingTop: insets.top + 10, paddingLeft: insets.left }}
    >
      <Head me={me} here={here} scoped={scoped} onProject={onProject} />
      {Option.isSome(refused) && (
        <View style={{ paddingHorizontal: GUTTER - 8, paddingBottom: 8 }}>
          <Notice message={refused.value} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Threads
          state={listed}
          query={Option.getOrElse(query, () => '')}
          width={width}
          onOpen={onOpen}
          onRename={onRename}
          onFile={Option.some(onFile)}
          onRefused={onRefused}
          onScroll={scrolled}
          header={
            <Beside
              all={filed}
              threads={threads}
              scoped={scopedId}
              onGo={onGo}
              onProject={onProject}
            />
          }
          empty={Option.match(scoped, {
            onNone: () => Option.none<string>(),
            onSome: (project) => Option.some(`No threads in ${project.name} yet.`),
          })}
        />
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: GUTTER - 4,
            right: GUTTER - 4,
            bottom: 12,
            flexDirection: 'row',
            justifyContent: 'flex-end',
            gap: 10,
          }}
        >
          <Seek query={query} onChange={setQuery} />
          {Option.isNone(query) && <Fresh expanded={expanded} onPress={onFresh} />}
        </View>
      </View>
      {!keyboard && <Foot me={me} here={here} onSwitch={onSwitch} onGo={onGo} />}
    </KeyboardAvoidingView>
  )
}
