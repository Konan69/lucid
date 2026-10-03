import { ThreadAudience, type Thread } from '@vivid/contracts'
import { Option, Result } from 'effect'
import { Users } from 'lucide-react-native'
import { View } from 'react-native'
import { commit, warn } from '../../data/haptics'
import { relativeTime, type Lane } from '../../data/lanes'
import { useLiveData } from '../../data/live'
import { deleteThread, patchThread } from '../../data/threads'
import { ControlPillMenu } from '../../t3/Menu'
import { ThreadSwipeable } from '../../t3/swipe'
import { useTheme } from '../../theme'
import { Faces } from '../../ui/Avatar'
import { confirmDestructive, Dot, EDGE, GUTTER, Label, Press, radius } from '../../ui/ui'

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
        borderCurve: 'continuous',
        borderWidth: EDGE,
        borderColor: c.border,
        backgroundColor: pressed ? c['row-hover'] : c['thread-selected'],
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
        <Label numberOfLines={2} size="label" tone="ink-2">
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
        minHeight: 46,
        marginHorizontal: GUTTER - 12,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderRadius: radius.row,
        backgroundColor: pressed ? c['row-hover'] : 'transparent',
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
      <Label
        size="caption"
        tone="drawer-foreground-muted"
        style={{ fontVariant: ['tabular-nums'] }}
      >
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
 *
 * Both are shown before the server has answered and taken back if it refuses. A row has nowhere
 * to say that, and a Thread that silently slides back reads as a swipe that did nothing, so what
 * came of each is handed to the list (`onRefused`), which says it where Home says refusals.
 */
export function ThreadRow({
  thread,
  variant,
  now,
  width,
  onOpen,
  onRename,
  onFile,
  onRefused,
}: {
  thread: Thread
  variant: Lane['variant']
  now: number
  /** How wide the list is: a full swipe is measured against it, and the drawer is not the screen. */
  width: number
  onOpen: (thread: Thread) => void
  onRename: (thread: Thread) => void
  /** Files the Thread in a Project. The menu offers it only where there is one to file it in. */
  onFile: Option.Option<(thread: Thread) => void>
  /** A sentence when a quick action was refused; none when the next one went through. */
  onRefused: (message: Option.Option<string>) => void
}) {
  const { colors: c } = useTheme()
  const data = useLiveData()
  const shelveLabel = thread.archived ? 'Move back to threads' : 'Mark as done'

  /** Follows a quick action to its end and tells the list what came of it. */
  const follow = async (made: Promise<Result.Result<unknown, unknown>>, words: string) => {
    const result = await made
    onRefused(Result.isFailure(result) ? Option.some(words) : Option.none())
  }

  const shelve = () => {
    commit()
    void follow(
      patchThread(data, thread.id, { archived: !thread.archived }),
      'That thread could not be moved just now. Try again.',
    )
  }
  const remove = () =>
    confirmDestructive({
      title: 'Delete this thread?',
      detail: `“${thread.title}” and everything in it will be gone for everyone who can see it. This cannot be undone.`,
      action: 'Delete thread',
      onConfirm: () => {
        warn()
        void follow(
          deleteThread(data, thread.id),
          `“${thread.title}” could not be deleted, so it is back in the list.`,
        )
      },
    })
  // What the long-press menu can do, by the id the native menu reports back when one is chosen.
  const filing = Option.match(onFile, {
    onNone: () => [],
    onSome: () => [{ id: 'file', title: 'Move to a project' }],
  })
  const chosen = new Map([
    ['rename', () => onRename(thread)],
    ['file', () => Option.map(onFile, (file) => file(thread))],
    ['shelve', shelve],
    ['remove', remove],
  ])

  return (
    <ThreadSwipeable
      backgroundColor={c.drawer}
      compactActions={variant === 'line'}
      fullSwipeAction="primary"
      fullSwipeWidth={width}
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
            ...filing,
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
