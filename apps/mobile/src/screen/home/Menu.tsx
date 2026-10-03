import { mayChangeAppearance, Workspace, type MeResponse, type Thread } from '@vivid/contracts'
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
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Library as LibraryIcon,
  Repeat2,
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
import type { ProjectId } from '@vivid/contracts'
import type { Routes } from '../../workspace'
import { Customise } from '../vivid/Customise'
import { Threads } from './Threads'

/** Where the drawer can send the Person that needs nothing said about it: a place, by its name. */
export type Place = {
  [Name in keyof Routes]: undefined extends Routes[Name] ? Name : never
}[keyof Routes]

/**
 * The places beside Threads. Projects is not one of them: a Person who has never made a Project
 * has no use for the word, so it appears only as the quiet group under their Threads (`Filed`).
 * Skills is not one either: a Person never manages skills. Vivid saves and reuses its own
 * procedures, so there is no Skills screen on any surface.
 */
const PLACES = [
  { route: 'Routines', label: 'Routines', icon: Repeat2 },
  { route: 'Library', label: 'Library', icon: LibraryIcon },
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
              style={[{ flex: 1, paddingVertical: 0, color: c.foreground }, MOBILE_TYPOGRAPHY.body]}
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
 * The drawer's contents, laid out for a thumb. The top is a title and nothing else: where the
 * Person is working. Everything pressed is from the middle down: the places, the Threads, then
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
  // "Add to a project" is offered only to a Person who has one. Nobody else sees the word.
  const hasProjects = LiveState.$is('Ready')(filed) && filed.value.projects.length > 0
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
  const editable = mayChangeAppearance(me.workspace)
  const [customising, setCustomising] = useState(false)

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
      {/* Vivid's face beside where the Person is. For someone who may change Vivid here it is
          the way in to the Customise sheet; for a member of a Company it is only a heading. */}
      <Press
        accessibilityRole={editable ? 'button' : 'header'}
        accessibilityLabel={editable ? `${here}. Customise Vivid` : here}
        disabled={!editable}
        onPress={() => setCustomising(true)}
        containerStyle={{ alignSelf: 'flex-start', maxWidth: '100%' }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          minHeight: TARGET,
          paddingHorizontal: GUTTER,
          paddingBottom: 6,
        }}
      >
        <Face size={28} label="" />
        <Label numberOfLines={1} size="heading" style={{ flexShrink: 1 }}>
          {here}
        </Label>
      </Press>
      {customising && <Customise onClose={() => setCustomising(false)} />}
      {Option.isSome(refused) && (
        <View style={{ paddingHorizontal: GUTTER - 8, paddingBottom: 8 }}>
          <Notice message={refused.value} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Threads
          state={threads}
          query={Option.getOrElse(query, () => '')}
          width={width}
          onOpen={onOpen}
          onRename={onRename}
          onFile={hasProjects ? Option.some(onFile) : Option.none()}
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
