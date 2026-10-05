import type { Notification, NotificationId } from '@vivid/contracts'
import {
  everyNoticeRead,
  noticeFace,
  noticeRows,
  NoticeRow,
  noticesRead,
  type NoticeFace,
} from '@vivid/state'
import { Option } from 'effect'
import { FlatList, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, CheckCheck, Hand, Share2, UserPlus, type LucideIcon } from 'lucide-react-native'
import { useNow } from '../data/foreground'
import { relativeTime } from '../data/lanes'
import { LiveState, useLive, useLiveData, useLiveValue, type LiveData } from '../data/live'
import { useTheme, type Colors } from '../theme'
import { Header, Screen } from '../ui/Header'
import { Live } from '../ui/Live'
import { Dot, Empty, GUTTER, IconButton, Label, Press, radius, Skeleton, styles } from '../ui/ui'
import { useGo } from '../workspace'

/**
 * Notifications: what finished or needs the Person while they were somewhere else. The phone had
 * no such list; something that finished in another Thread could only be found by reading the
 * Thread list for what had moved.
 *
 * It is a screen on the app's one stack, pushed from the drawer and left by the system's back
 * swipe, not the web's panel hung from a bell: a phone has no corner to hang a panel from, and a
 * list this long wants the whole screen. The rows, their words and what reading one means are
 * the web's, from the same shared model (`@vivid/state` `notices.ts`); only the drawing is the
 * phone's.
 *
 * It owns no data. The list is the live query, which starts from what the phone kept
 * (`data/snapshot.ts`), so it is drawn at once on a cold start and corrected when the server
 * answers; a press is shown at once and taken back if the server refuses it.
 */
export function Notifications() {
  const data = useLiveData()
  const go = useGo()
  const insets = useSafeAreaInsets()
  const state = useLive(data.live.notifications)
  const threads = useLiveValue(data.live.threads)
  // The moment the app last came to the front: times do not tick under a finger.
  const now = useNow()
  const unread = LiveState.$is('Ready')(state)
    ? state.value.notifications.filter((notice) => notice.readAt === null).length
    : 0

  /** Goes to what a row is about, marking all of it read on the way. */
  const visit = NoticeRow.$match({
    // A notice about no Thread has nowhere on the phone to go; pressing it is reading it.
    Single: ({ notice }) => read(data, notice.readAt === null ? [notice.id] : []),
    // A Thread that was deleted still opens: its screen says it is gone, in the server's words.
    Grouped: ({ threadId, unread: ids }) => {
      read(data, ids)
      go.navigate('Chat', { id: threadId })
    },
  })

  return (
    <Screen>
      <Header
        title="Notifications"
        onBack={go.goBack}
        trailing={
          <IconButton
            icon={CheckCheck}
            label="Mark all read"
            disabled={unread === 0}
            onPress={() => readAll(data)}
          />
        }
      />
      <Live
        state={state}
        loading={
          <View style={[styles.page, styles.column]}>
            <Skeleton rows={5} />
          </View>
        }
      >
        {(value) => (
          <FlatList
            data={noticeRows(
              value.notifications,
              // Until the Thread list has answered, a row leads with its notice's own title.
              Option.match(threads, { onNone: () => [], onSome: (list) => list.threads }),
            )}
            keyExtractor={(row) => noticeFace(row).key}
            renderItem={({ item }) => (
              <Line face={noticeFace(item)} now={now} onOpen={() => visit(item)} />
            )}
            ListEmptyComponent={
              <View style={{ paddingHorizontal: 12 }}>
                <Empty line="You’re all caught up. When Vivid finishes something or needs you, it’s listed here." />
              </View>
            }
            contentContainerStyle={[
              styles.column,
              { paddingHorizontal: GUTTER - 12, paddingTop: 4, paddingBottom: insets.bottom + 24 },
            ]}
          />
        )}
      </Live>
    </Screen>
  )
}

/** Shows these notices as read at once, sends that, and takes it back if the server refuses. */
function read(data: LiveData, ids: ReadonlyArray<NotificationId>) {
  // Nothing unread is nothing to send; a request with no ids would also not mean "none".
  if (ids.length === 0) return
  const at = Date.now()
  void data.change(
    (client) => client.ReadNotifications({ ids }),
    () => data.live.notifications.expect(noticesRead(ids, at)),
  )
}

/** Marks every notice read, shown at once the same way. */
function readAll(data: LiveData) {
  const at = Date.now()
  void data.change(
    (client) => client.ReadNotifications({}),
    () => data.live.notifications.expect(everyNoticeRead(at)),
  )
}

/**
 * The mark each kind of notice leads with, so the list can be read by colour before a word of it
 * is: green for done, orange for "this needs you", blue for something shared, magenta for an
 * invitation. The colours are the palette's own (`face-*`), the ones a Project's mark uses. A new
 * kind of notice fails to compile here.
 */
const KIND = {
  finished: { icon: Check, color: 'face-green' },
  'needs-you': { icon: Hand, color: 'face-orange' },
  shared: { icon: Share2, color: 'face-blue' },
  invited: { icon: UserPlus, color: 'face-magenta' },
} as const satisfies Record<Notification['kind'], { icon: LucideIcon; color: keyof Colors }>

/** The tile a row leads with. A read row's steps back, so what is new is found without reading. */
function Tile({ kind, unread }: { kind: Notification['kind']; unread: boolean }) {
  const { colors: c } = useTheme()
  const { icon: Icon, color } = KIND[kind]
  return (
    <View
      pointerEvents="none"
      style={{
        width: 34,
        height: 34,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.row,
        borderCurve: 'continuous',
        backgroundColor: c['wash-pressed'],
        opacity: unread ? 1 : 0.6,
      }}
    >
      <Icon size={17} strokeWidth={1.7} color={c[color]} />
    </View>
  )
}

/** What a screen reader says for a row: what it is, where it leads, what was said, what is new. */
const spokenOf = (face: NoticeFace): string =>
  [
    Option.getOrElse(face.spoken, () => ''),
    face.heading,
    face.waiting ? 'Needs you' : '',
    face.line,
    face.unread > 0 ? `${face.unread} unread` : '',
  ]
    .filter((part) => part.length > 0)
    .join('. ')

/**
 * One row: the newest notice's mark, where it leads (a Thread's title), and under it one line of
 * what was last said, with what is unread at the trailing edge.
 *
 * The layout is the web panel's row, for the same reasons: the time is alone at the end of the
 * first line, so a long title keeps its room beside it; the unread count and dot sit at the end
 * of the second line, which is the one that gives way. Both lines are one line each, so every
 * row is the same height and a count that changes changes words, not layout. The whole row is
 * the target, 58 points tall, and darkens under a finger.
 */
function Line({
  face,
  now,
  onOpen,
}: {
  face: NoticeFace
  /** The moment times are counted from. */
  now: number
  onOpen: () => void
}) {
  const { colors: c } = useTheme()
  const unread = face.unread > 0
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={spokenOf(face)}
      onPress={onOpen}
      style={({ pressed }) => ({
        minHeight: 58,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: radius.row,
        borderCurve: 'continuous',
        backgroundColor: pressed ? c['row-hover'] : 'transparent',
      })}
    >
      <Tile kind={face.notice.kind} unread={unread} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Label
            numberOfLines={1}
            tone={unread ? 'ink' : 'ink-2'}
            style={{ flex: 1, fontWeight: unread ? '600' : '400' }}
          >
            {face.heading}
          </Label>
          <Label size="caption" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
            {relativeTime(face.notice.createdAt, now)}
          </Label>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {face.waiting && (
            <Label size="label" tone="status-attention">
              Needs you
            </Label>
          )}
          <Label numberOfLines={1} size="label" tone="ink-3" style={{ flex: 1 }}>
            {face.line}
          </Label>
          {face.unread > 1 && (
            <Label size="caption" tone="ink-2" style={{ fontVariant: ['tabular-nums'] }}>
              {face.unread} new
            </Label>
          )}
          {unread && <Dot tone="accent" size={8} />}
        </View>
      </View>
    </Press>
  )
}
