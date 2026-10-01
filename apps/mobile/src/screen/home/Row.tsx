import { ThreadAudience, type Thread } from '@vivid/contracts'
import { Users } from 'lucide-react-native'
import { useWindowDimensions, View } from 'react-native'
import { commit, warn } from '../../data/haptics'
import { relativeTime, type Lane } from '../../data/lanes'
import { useLiveData } from '../../data/live'
import { deleteThread, patchThread } from '../../data/threads'
import { ControlPillMenu } from '../../t3/Menu'
import { ThreadSwipeable } from '../../t3/swipe'
import { useTheme } from '../../theme'
import { Faces } from '../../ui/Avatar'
import { confirmDestructive, Dot, GUTTER, HAIRLINE, Label, Press, radius } from '../../ui/ui'

/** Who else is in a Thread: faces for named people, a mark for the whole Company. */
function Audience({ thread }: { thread: Thread }) {
  const { colors: c } = useTheme()
  return ThreadAudience.match(thread.audience, {
    Private: () => null,
    People: ({ participants }) => <Faces people={participants} size={18} />,
    Company: () => (
      <Users
        accessibilityLabel="Shared with the company"
        size={15}
        strokeWidth={1.7}
        color={c['ink-3']}
      />
    ),
  })
}

/** The word and color a card leads with. Only the two attention lanes are drawn as cards. */
function Standing({ thread }: { thread: Thread }) {
  const needsYou = thread.attention === 'NeedsYou'
  const tone = needsYou ? 'status-attention' : 'status-working'
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Dot tone={tone} size={6} />
      <Label size="caption" tone={tone}>
        {needsYou ? 'Needs you' : 'Working'}
      </Label>
    </View>
  )
}

/** A Thread that needs someone or is being worked on: its state, who is in it, its last words. */
function CardFace({ thread, pressed }: { thread: Thread; pressed: boolean }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        marginHorizontal: GUTTER - 6,
        marginVertical: 4,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 3,
        borderRadius: radius.card,
        borderWidth: HAIRLINE,
        borderColor: c['line-2'],
        backgroundColor: pressed ? c['surface-3'] : c['surface-2'],
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 18 }}>
        <Standing thread={thread} />
        <View style={{ flex: 1 }} />
        <Audience thread={thread} />
      </View>
      <Label numberOfLines={1} size="footnote" style={{ fontSize: 15 }}>
        {thread.title}
      </Label>
      {thread.preview.length > 0 && (
        <Label numberOfLines={2} size="label" tone="ink-3">
          {thread.preview}
        </Label>
      )}
    </View>
  )
}

/** Any other Thread: a mark that says whether something in it is unread, its title, and when. */
function LineFace({ thread, now, pressed }: { thread: Thread; now: number; pressed: boolean }) {
  const { colors: c } = useTheme()
  const unread = thread.attention === 'Unread'
  return (
    <View
      style={{
        minHeight: 48,
        paddingHorizontal: GUTTER,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
      }}
    >
      <Dot tone={unread ? 'accent' : 'line-4'} size={unread ? 8 : 6} />
      <Label
        numberOfLines={1}
        tone={unread ? 'ink' : 'ink-2'}
        style={{ flex: 1, fontWeight: unread ? '600' : '400' }}
      >
        {thread.title}
      </Label>
      <Audience thread={thread} />
      <Label size="caption" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
        {relativeTime(thread.updatedAt, now)}
      </Label>
    </View>
  )
}

/**
 * One Thread in the list. A tap opens it. A swipe marks it done (or brings a done one back),
 * and a long press offers everything else, so a row never grows a strip of buttons.
 *
 * Marking done is shown at once and confirmed by the server's next result. Deleting is the one
 * thing here that cannot be taken back, so it is the one thing that asks first.
 */
export function ThreadRow({
  thread,
  variant,
  now,
  onOpen,
  onRename,
}: {
  thread: Thread
  variant: Lane['variant']
  now: number
  onOpen: (thread: Thread) => void
  onRename: (thread: Thread) => void
}) {
  const { colors: c } = useTheme()
  const data = useLiveData()
  const window = useWindowDimensions()
  const shelveLabel = thread.archived ? 'Move back to threads' : 'Mark as done'

  const shelve = () => {
    commit()
    void patchThread(data, thread.id, { archived: !thread.archived })
  }
  const remove = () =>
    confirmDestructive({
      title: 'Delete this thread?',
      detail: `“${thread.title}” and everything in it will be gone for everyone who can see it. This cannot be undone.`,
      action: 'Delete thread',
      onConfirm: () => {
        warn()
        void deleteThread(data, thread.id)
      },
    })
  // What the long-press menu can do, by the id the native menu reports back when one is chosen.
  const chosen = new Map([
    ['rename', () => onRename(thread)],
    ['shelve', shelve],
    ['remove', remove],
  ])

  return (
    <ThreadSwipeable
      backgroundColor={c['surface-0']}
      compactActions={variant === 'line'}
      fullSwipeAction="primary"
      fullSwipeWidth={window.width}
      threadTitle={thread.title}
      onDelete={remove}
      primaryAction={{
        accessibilityLabel: `${shelveLabel}: ${thread.title}`,
        icon: thread.archived ? 'arrow.uturn.backward' : 'archivebox',
        label: thread.archived ? 'Restore' : 'Done',
        onPress: shelve,
      }}
    >
      {() => (
        <ControlPillMenu
          shouldOpenOnLongPress
          title={thread.title}
          actions={[
            { id: 'rename', title: 'Rename' },
            { id: 'shelve', title: shelveLabel },
            { id: 'remove', title: 'Delete…', attributes: { destructive: true } },
          ]}
          onPressAction={({ nativeEvent }) => {
            const act = chosen.get(nativeEvent.event)
            if (act !== undefined) act()
          }}
        >
          <Press accessibilityRole="button" onPress={() => onOpen(thread)}>
            {({ pressed }) =>
              variant === 'card' ? (
                <CardFace thread={thread} pressed={pressed} />
              ) : (
                <LineFace thread={thread} now={now} pressed={pressed} />
              )
            }
          </Press>
        </ControlPillMenu>
      )}
    </ThreadSwipeable>
  )
}
