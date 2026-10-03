import { Workspace, type MeResponse, type Thread } from '@vivid/contracts'
import { projects } from '@vivid/state'
import { Option } from 'effect'
import { useRef, useState, type ReactNode } from 'react'
import { TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Library as LibraryIcon,
  Repeat2,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  SquarePen,
  type LucideIcon,
} from 'lucide-react-native'
import { collapseAt, RESTING } from '../../data/collapse'
import { LiveState, useLive, useLiveData } from '../../data/live'
import { MOBILE_TYPOGRAPHY } from '../../data/typography'
import { useTheme } from '../../theme'
import { Avatar, pictureOf } from '../../ui/Avatar'
import { Glass } from '../../ui/Glass'
import { APPEAR, LEAVE, MORPH } from '../../ui/motion/morph'
import { EDGE, GUTTER, Label, Notice, Press, radius, TARGET } from '../../ui/ui'
import type { ProjectId } from '@vivid/contracts'
import type { Routes } from '../../workspace'
import { Threads } from './Threads'

/** Where the drawer can send the Person that needs nothing said about it: a place, by its name. */
export type Place = {
  [Name in keyof Routes]: undefined extends Routes[Name] ? Name : never
}[keyof Routes]

/**
 * The places beside Threads. Projects is not one of them: a Person who has never made a Project
 * has no use for the word, so it appears only as the quiet group under their Threads (`Filed`).
 */
const PLACES = [
  { route: 'Routines', label: 'Routines', icon: Repeat2 },
  { route: 'Library', label: 'Library', icon: LibraryIcon },
  { route: 'Skills', label: 'Skills', icon: Sparkles },
] as const satisfies ReadonlyArray<{ route: Place; label: string; icon: LucideIcon }>

/** One line of the drawer that goes somewhere: a mark, a name, and at most one thing after it. */
function Line({
  icon: Icon,
  leading,
  label,
  accessibilityLabel,
  trailing,
  expanded,
  onPress,
}: {
  icon?: LucideIcon
  /** Stands where the icon would, when the line is a Person and not a place. */
  leading?: ReactNode
  label: string
  accessibilityLabel?: string
  trailing?: ReactNode
  expanded?: boolean
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 46,
        marginHorizontal: GUTTER - 12,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: radius.row,
        backgroundColor: pressed ? c['row-hover'] : 'transparent',
      })}
    >
      {Icon !== undefined && (
        <Icon pointerEvents="none" size={19} strokeWidth={1.7} color={c.foreground} />
      )}
      {leading}
      <Label numberOfLines={1} style={{ flex: 1 }}>
        {label}
      </Label>
      {trailing}
    </Press>
  )
}

/** Where the Person is working, and the way to somewhere else. */
function Where({ me, onSwitch }: { me: MeResponse; onSwitch: () => void }) {
  const { colors: c } = useTheme()
  const here = Workspace.match(me.workspace, {
    Personal: () => 'Vivid',
    Company: ({ company }) => company.name,
  })
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={`Working in ${here}. Change workspace`}
      onPress={onSwitch}
      style={({ pressed }) => ({
        minHeight: TARGET,
        marginHorizontal: GUTTER - 12,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: radius.row,
        backgroundColor: pressed ? c['row-hover'] : 'transparent',
      })}
    >
      <Label numberOfLines={1} size="heading" style={{ flexShrink: 1 }}>
        {here}
      </Label>
      <ChevronsUpDown pointerEvents="none" size={15} strokeWidth={1.8} color={c.chevron} />
    </Press>
  )
}

/** Search across every Thread, current and done. It filters the list under it as it is typed. */
function Sought({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        marginHorizontal: GUTTER - 8,
        marginTop: 6,
        marginBottom: 8,
        paddingHorizontal: 14,
        minHeight: TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderRadius: TARGET / 2,
        borderWidth: EDGE,
        borderColor: c.border,
        backgroundColor: c.subtle,
      }}
    >
      <Search pointerEvents="none" size={17} strokeWidth={1.8} color={c['foreground-secondary']} />
      <TextInput
        accessibilityLabel="Search threads"
        value={text}
        placeholder="Search threads"
        placeholderTextColor={c['foreground-secondary']}
        selectionColor={c.primary}
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
        onChangeText={onChange}
        style={[{ flex: 1, paddingVertical: 0, color: c.foreground }, MOBILE_TYPOGRAPHY.body]}
      />
    </View>
  )
}

/**
 * Projects, for a Person who has any or who works in a Company: one collapsed line under their
 * Threads that opens to the Project names. Nobody else sees the word here. "All projects" is the
 * way to the Projects screen, where one is made.
 */
function Filed({
  me,
  onGo,
  onProject,
}: {
  me: MeResponse
  onGo: (place: Place) => void
  onProject: (id: ProjectId) => void
}) {
  const data = useLiveData()
  const { colors: c } = useTheme()
  const list = useLive(data.live.projects)
  const [open, setOpen] = useState(false)
  if (!LiveState.$is('Ready')(list)) return null
  const top = projects.projectsIn(list.value.projects, null)
  if (top.length === 0 && !Workspace.guards.Company(me.workspace)) return null
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <Animated.View layout={MORPH} style={{ marginTop: 12 }}>
      <Line
        label="Projects"
        expanded={open}
        onPress={() => setOpen((shown) => !shown)}
        trailing={<Chevron pointerEvents="none" size={16} strokeWidth={1.7} color={c.chevron} />}
      />
      {open && (
        <Animated.View entering={APPEAR} exiting={LEAVE} style={{ paddingLeft: 12 }}>
          {top.map((project) => (
            <Line key={project.id} label={project.name} onPress={() => onProject(project.id)} />
          ))}
          <Line label="All projects" onPress={() => onGo('Projects')} />
        </Animated.View>
      )}
    </Animated.View>
  )
}

/**
 * The way to a new Thread, floating over the list: its mark and its words at rest, the mark alone
 * while the list is moving down under it, so it never covers the row being read.
 *
 * The behaviour is T3 Code mobile's Android home button
 * (`src/components/MaterialFloatingActionButton.android.tsx`, driven by
 * `src/features/home/material-fab-scroll.ts`): extended at rest, collapsed while scrolling. The
 * reference draws a Compose button through `@expo/ui`; Vivid draws its own glass pill on both
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
      containerStyle={{ position: 'absolute', right: GUTTER - 4, bottom: 14 }}
    >
      <Glass radius={28} style={{ backgroundColor: c.primary, borderColor: c.primary }}>
        <View
          style={{
            height: 56,
            minWidth: 56,
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
 * The drawer's contents: where the Person is working, a search, the places beside Threads, the
 * Threads themselves, and at the foot the Person and their Settings.
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
  onRefused: (message: Option.Option<string>) => void
}) {
  const data = useLiveData()
  const insets = useSafeAreaInsets()
  const { colors: c } = useTheme()
  const threads = useLive(data.live.threads)
  const [query, setQuery] = useState('')
  // The scroll position is tracked in a ref: only the moment the button changes shape is state,
  // so a moving list renders nothing.
  const scroll = useRef(RESTING)
  const [expanded, setExpanded] = useState(true)

  function scrolled({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) {
    const furthest = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height
    scroll.current = collapseAt(scroll.current, nativeEvent.contentOffset.y, furthest)
    if (scroll.current.expanded !== expanded) setExpanded(scroll.current.expanded)
  }

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6, paddingLeft: insets.left }}>
      <Where me={me} onSwitch={onSwitch} />
      <Sought text={query} onChange={setQuery} />
      {Option.isSome(refused) && (
        <View style={{ paddingHorizontal: GUTTER - 8, paddingBottom: 8 }}>
          <Notice message={refused.value} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Threads
          state={threads}
          query={query}
          width={width}
          onOpen={onOpen}
          onRename={onRename}
          onRefused={onRefused}
          onScroll={scrolled}
          header={
            <View style={{ paddingBottom: 4 }}>
              {PLACES.map(({ route, label, icon }) => (
                <Line key={route} icon={icon} label={label} onPress={() => onGo(route)} />
              ))}
            </View>
          }
          footer={<Filed me={me} onGo={onGo} onProject={onProject} />}
        />
        <Fresh expanded={expanded} onPress={onFresh} />
      </View>
      <View
        style={{
          borderTopWidth: EDGE,
          borderTopColor: c['border-subtle'],
          paddingTop: 6,
          paddingBottom: Math.max(insets.bottom, 8),
        }}
      >
        <Line
          leading={<Avatar name={me.person.name} image={pictureOf(me.person)} size={28} />}
          label={me.person.name}
          accessibilityLabel={`${me.person.name}. Settings`}
          onPress={() => onGo('Settings')}
          trailing={
            <SettingsIcon
              pointerEvents="none"
              size={18}
              strokeWidth={1.7}
              color={c['drawer-foreground-muted']}
            />
          }
        />
      </View>
    </View>
  )
}
