import { ThreadAudience, type Thread } from '@vivid/contracts'
import { Effect, Option, Result } from 'effect'
import { Users } from 'lucide-react-native'
import { useState } from 'react'
import { View } from 'react-native'
import { commit, warn } from '../../data/haptics'
import { relativeTime } from '../../data/lanes'
import { useLiveData } from '../../data/live'
import { deleteThread, patchThread, retitleThread } from '../../data/threads'
import { HoldMenu } from '../../t3/Menu'
import { ThreadSwipeable } from '../../t3/swipe'
import { useTheme } from '../../theme'
import { Faces } from '../../ui/Avatar'
import { confirmDestructive, Dot, GUTTER, Label, radius } from '../../ui/ui'
import { start } from '../../data/app'

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

/** What each face of a row is told: the Thread, whether a finger is on it, and its title's state. */
interface FaceProps {
  readonly thread: Thread
  readonly pressed: boolean
  /** Whether Vivid has been asked for a better title and has not answered yet. */
  readonly retitling: boolean
}

/** A title Vivid is thinking of a replacement for is drawn quieter, and still, until it lands. */
const titleOpacity = (retitling: boolean) => (retitling ? 0.5 : 1)

/**
 * The mark a row leads with, by what the Thread wants of the Person. The lane's heading says the
 * same in words, so the row itself carries no label: only this color and size.
 */
const MARK = {
  NeedsYou: { tone: 'status-attention', size: 8 },
  Working: { tone: 'status-working', size: 8 },
  Unread: { tone: 'accent', size: 8 },
  Quiet: { tone: 'line-4', size: 6 },
} as const satisfies Record<Thread['attention'], { tone: string; size: number }>

/**
 * A Thread as one line: its mark, its title, who else is in it, and when it last moved. Every
 * lane draws its Threads this way. The attention lanes used to draw cards with the lane's name
 * and two lines of the last message; the name repeated the heading and the words made rows of
 * different heights, so a list of five read as a page. The drawer finds a Thread; the Thread
 * itself is where it is read.
 */
function LineFace({ thread, now, pressed, retitling }: FaceProps & { readonly now: number }) {
  const { colors: c } = useTheme()
  const mark = MARK[thread.attention]
  // Anything but a quiet Thread is waiting to be looked at, and its title is drawn to say so.
  const unread = thread.attention !== 'Quiet'
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
      <Dot tone={mark.tone} size={mark.size} />
      <Label
        numberOfLines={1}
        tone={unread ? 'ink' : 'ink-2'}
        style={{ flex: 1, fontWeight: unread ? '600' : '400', opacity: titleOpacity(retitling) }}
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
  now,
  width,
  onOpen,
  onRename,
  onFile,
  onRefused,
}: {
  thread: Thread
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
  const [retitling, setRetitling] = useState(false)

  /** Follows a quick action to its end and tells the list what came of it. */
  const follow = (made: Effect.Effect<Result.Result<unknown, unknown>>, words: string) =>
    start(
      Effect.map(made, (result) =>
        onRefused(Result.isFailure(result) ? Option.some(words) : Option.none()),
      ),
    )

  const shelve = () => {
    commit()
    void follow(
      patchThread(data, thread.id, { archived: !thread.archived }),
      'That thread could not be moved just now. Try again.',
    )
  }
  /**
   * Asks Vivid for a better title. The title is drawn quieter while Vivid thinks, since the menu
   * has closed and nothing else would say the press was heard; a second press while one is
   * already asked does nothing.
   */
  const retitle = () => {
    if (retitling) return
    commit()
    setRetitling(true)
    // The title is drawn plainly again however the asking ends, and before the list hears what
    // came of it, as when both waited on one Promise.
    const asked = retitleThread(data, thread.id).pipe(
      Effect.ensuring(Effect.sync(() => setRetitling(false))),
    )
    void follow(asked, 'Vivid could not think of a better title just now.')
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
  // What the menu on a hold can do, by the id the native menu reports back when one is chosen.
  const filing = Option.match(onFile, {
    onNone: () => [],
    onSome: () => [{ id: 'file', title: 'Move to a project' }],
  })
  const chosen = new Map([
    ['rename', () => onRename(thread)],
    ['retitle', retitle],
    ['file', () => Option.map(onFile, (file) => file(thread))],
    ['shelve', shelve],
    ['remove', remove],
  ])

  return (
    <ThreadSwipeable
      backgroundColor={c.drawer}
      compactActions
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
      <HoldMenu
        title={thread.title}
        actions={[
          { id: 'rename', title: 'Rename' },
          { id: 'retitle', title: 'Regenerate title' },
          ...filing,
          { id: 'shelve', title: shelveLabel },
          { id: 'remove', title: 'Delete…', attributes: { destructive: true } },
        ]}
        onChoose={(id) => {
          const act = chosen.get(id)
          if (act !== undefined) act()
        }}
        onPress={() => onOpen(thread)}
      >
        {({ pressed }) => (
          <LineFace thread={thread} now={now} pressed={pressed} retitling={retitling} />
        )}
      </HoldMenu>
    </ThreadSwipeable>
  )
}
