import type { Notification } from '@vivid/contracts'
import type { NoticeFace } from '@vivid/state'
import { Option } from 'effect'
import { I18nManager, useWindowDimensions, View } from 'react-native'
import { Check, ExternalLink, Hand, Share2, UserPlus, type LucideIcon } from 'lucide-react-native'
import { relativeTime } from '../../data/lanes'
import { MOBILE_TYPOGRAPHY } from '../../data/typography'
import { useTheme, type Colors } from '../../theme'
import { Dot, GUTTER, Label, Press, radius } from '../../ui/ui'
import { answers, Destination } from './destination'

/** The side of the mark a row leads with. */
const TILE = 36

/**
 * The mark each kind of notice leads with: its picture, and the ink and fill it is drawn in
 * while unread. Colour here is a state and nothing else, in the palette's own state tokens:
 * green for "done", the accent for "this needs you". A Thread someone shared and an invitation
 * are not states of the Person's work, so they stay in the neutral ink and are told apart by
 * their picture and their words. A new kind of notice fails to compile here.
 */
const KIND = {
  finished: { icon: Check, ink: 'status-success', fill: 'status-success-soft' },
  'needs-you': { icon: Hand, ink: 'status-attention', fill: 'status-attention-soft' },
  shared: { icon: Share2, ink: 'ink-2', fill: 'wash-pressed' },
  invited: { icon: UserPlus, ink: 'ink-2', fill: 'wash-pressed' },
} as const satisfies Record<
  Notification['kind'],
  { icon: LucideIcon; ink: keyof Colors; fill: keyof Colors }
>

/**
 * The tile a row leads with. A read row's steps back to the quiet ink on the quiet wash and keeps
 * its picture, so what is new is found by colour before a word is read and what is old can still
 * be told apart.
 */
function Tile({ kind, unread }: { kind: Notification['kind']; unread: boolean }) {
  const { colors: c } = useTheme()
  const { icon: Icon, ink, fill } = KIND[kind]
  return (
    <View
      pointerEvents="none"
      style={{
        width: TILE,
        height: TILE,
        // Three points down puts the tile's middle on the middle of a title over one line of
        // words (23 + 2 + 17), which is the row most often drawn.
        marginTop: 3,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.row,
        borderCurve: 'continuous',
        backgroundColor: c[unread ? fill : 'wash-hover'],
      }}
    >
      <Icon size={18} strokeWidth={1.8} color={c[unread ? ink : 'ink-3']} />
    </View>
  )
}

/**
 * The direction a row's own words are laid out in: the app's, not the words'. A title is another
 * Person's text in any script. On iOS a line that begins with a right-to-left letter is laid out
 * right to left and so hangs from the far edge of its box, away from the edge every other title
 * starts at; naming the app's direction keeps it on that edge while the letters themselves still
 * run the right way. Android already lays text out from the layout's start
 * (`TextLayoutManager.kt`, "ALIGN_OPPOSITE needs to be used to align RTL script to the left").
 */
const UPRIGHT = { writingDirection: I18nManager.isRTL ? 'rtl' : 'ltr' } as const

/** Counts are written the way the Person's own locale writes them: "1,000", not "1000". */
const count = new Intl.NumberFormat()

/** The outer shape every row shares, pressed or not, so text rows and buttons sit on one grid. */
const FRAME = {
  // The fill a finger darkens stops 8 points short of the glass; the words inside start on the
  // page's gutter, under the bar's title.
  marginHorizontal: GUTTER - 12,
  paddingHorizontal: 12,
  paddingVertical: 10,
  flexDirection: 'row',
  // The tile hangs from the top: a row grows downward when its words wrap or the text is large.
  alignItems: 'flex-start',
  gap: 12,
  borderRadius: radius.row,
  borderCurve: 'continuous',
} as const

/**
 * What stands between a row's heading and its words when the row has something to say about
 * where it leads: that its Thread is waiting on the Person, or that its Thread is gone.
 */
function Standing({ face, leads }: { face: NoticeFace; leads: Destination }) {
  if (face.waiting) {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Dot tone="status-attention" size={6} />
        <Label size="caption" tone="status-attention" style={{ fontWeight: '600' }}>
          Needs you
        </Label>
      </View>
    )
  }
  if (Destination.$is('Gone')(leads)) {
    return (
      <Label size="caption" tone="ink-3">
        This thread is no longer available
      </Label>
    )
  }
  return null
}

/** What is unread in a row, at its trailing edge: one dot, and how many when it is several. */
function Unread({ face }: { face: NoticeFace }) {
  // The cluster is as tall as the first line of the words beside it, at the Person's own text
  // size, so the dot sits on that line's middle whatever the size.
  const { fontScale } = useWindowDimensions()
  return (
    <View
      style={{
        height: MOBILE_TYPOGRAPHY.label.lineHeight * fontScale,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
      }}
    >
      {face.unread > 1 && (
        <Label
          size="caption"
          tone="accent-ink"
          style={{ fontWeight: '600', fontVariant: ['tabular-nums'] }}
        >
          {count.format(face.unread)} new
        </Label>
      )}
      <Dot tone="accent" size={8} />
    </View>
  )
}

/**
 * The words of a row, beside its tile: where it leads and when, what stands there, what was
 * last said, and what is unread.
 *
 * - The heading and the time share a line. The time is never cut; the heading gives way. A
 *   Thread's title is a name and keeps to one line, and the whole of it is one press away. A
 *   notice's own title is a sentence ("… invited you to …") and may take two.
 * - The words under it take up to two lines: a phone is wide enough to say what happened, where
 *   the web's narrow panel has room for one.
 * - What is unread sits at the end of the first of those lines, so a count that changes changes
 *   words there and nothing above it moves.
 */
function Words({ face, leads, now }: { face: NoticeFace; leads: Destination; now: number }) {
  const { colors: c } = useTheme()
  const unread = face.unread > 0
  const said = face.line.trim()
  return (
    // At least as tall as the tile and centred in that, so a row with a title and nothing under
    // it sits level with its tile instead of above it.
    <View style={{ flex: 1, minWidth: 0, minHeight: TILE + 6, justifyContent: 'center', gap: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Label
          numberOfLines={Option.isSome(face.spoken) ? 1 : 2}
          tone={unread ? 'ink' : 'ink-2'}
          style={[{ flex: 1, fontWeight: unread ? '600' : '400' }, UPRIGHT]}
        >
          {face.heading}
        </Label>
        <Label size="caption" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
          {relativeTime(face.notice.createdAt, now)}
        </Label>
      </View>
      <Standing face={face} leads={leads} />
      {(said.length > 0 || unread) && (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <Label
            numberOfLines={2}
            size="label"
            tone={unread ? 'ink-2' : 'ink-3'}
            style={[{ flex: 1 }, UPRIGHT]}
          >
            {said}
          </Label>
          {unread && <Unread face={face} />}
        </View>
      )}
      {Destination.$is('Invitation')(leads) && (
        // Said in words before the press, not only to a screen reader: this row leaves the app.
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
          <ExternalLink pointerEvents="none" size={12} strokeWidth={1.8} color={c['ink-3']} />
          <Label size="caption" tone="ink-3">
            Opens in your browser
          </Label>
        </View>
      )}
    </View>
  )
}

/** What a screen reader says for a row: what it is, where it leads, what was said, what is new. */
const spokenOf = (face: NoticeFace, leads: Destination, now: number): string =>
  [
    Option.getOrElse(face.spoken, () => ''),
    face.heading,
    face.waiting ? 'Needs you' : '',
    Destination.$is('Gone')(leads) ? 'This thread is no longer available' : '',
    face.line.trim(),
    face.unread > 0 ? `${count.format(face.unread)} unread` : '',
    relativeTime(face.notice.createdAt, now),
  ]
    .filter((part) => part.length > 0)
    .join('. ')

/** What a screen reader calls a row that can be pressed, and what it says the press will do. */
const pressed = Destination.$match({
  Thread: () => ({ role: 'button', hint: 'Opens the thread' }) as const,
  Invitation: () => ({ role: 'link', hint: 'Opens in your browser' }) as const,
  Gone: () => ({ role: 'button', hint: 'Marks this as read' }) as const,
  Nowhere: () => ({ role: 'button', hint: 'Marks this as read' }) as const,
})

/**
 * One row of the Notifications screen.
 *
 * The form is an inbox row as a phone draws one, not the web panel's line: a mark hung from the
 * top, a heading over up to two lines of what was said, and what is unread at the trailing edge
 * (Inline's iOS chat row, `apple/InlineIOS/Lists/DirectChatItem.swift`: `HStack(alignment:
 * .top)`, a body-size title over a two-line secondary preview, an accent dot for unread). The
 * type steps, the pressed fill and the way the surface sinks under a finger are the Thread
 * list's (`screen/home/Row.tsx`), so the two lists feel like one app.
 *
 * A row that leads somewhere, or that a press would read, is a control: the whole row is the
 * target (never under 62 points tall) and it darkens and sinks under a finger. A row that would
 * do nothing is not a control and does not answer like one.
 */
export function NoticeLine({
  face,
  leads,
  now,
  onPress,
}: {
  face: NoticeFace
  leads: Destination
  /** The moment times are counted from. */
  now: number
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  const label = spokenOf(face, leads, now)
  const inside = (
    <>
      <Tile kind={face.notice.kind} unread={face.unread > 0} />
      <Words face={face} leads={leads} now={now} />
    </>
  )
  if (!answers(leads, face.unread)) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={label} style={FRAME}>
        {inside}
      </View>
    )
  }
  const { role, hint } = pressed(leads)
  return (
    <Press
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed: held }) => [
        FRAME,
        { backgroundColor: held ? c['row-hover'] : 'transparent' },
      ]}
    >
      {inside}
    </Press>
  )
}

/** The widths the outline's two bars take, row by row, so it reads as a list of sentences. */
const BARS = [
  ['58%', '92%'],
  ['44%', '76%'],
  ['66%', '84%'],
  ['50%', '68%'],
  ['62%', '88%'],
] as const

/**
 * The outline of the list while its first answer is on its way and the phone has kept nothing
 * to draw: the rows' own shape (a tile, a heading, a line of words), still. It does not shimmer,
 * as no outline in the app does (`ui/ui.tsx` `Skeleton`): the answer arrives in less time than a
 * shimmer takes to be seen, and a loading list should not cost a frame.
 */
export function NoticeOutline() {
  const { colors: c } = useTheme()
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel="Loading notifications">
      {BARS.map(([heading, words]) => (
        <View key={`${heading}:${words}`} style={FRAME}>
          <View
            style={{
              width: TILE,
              height: TILE,
              marginTop: 3,
              borderRadius: radius.row,
              borderCurve: 'continuous',
              backgroundColor: c['wash-hover'],
            }}
          />
          <View style={{ flex: 1, minHeight: TILE + 6, justifyContent: 'center', gap: 9 }}>
            <View
              style={{
                height: 13,
                width: heading,
                borderRadius: 7,
                backgroundColor: c['wash-pressed'],
              }}
            />
            <View
              style={{
                height: 10,
                width: words,
                borderRadius: 5,
                backgroundColor: c['wash-hover'],
              }}
            />
          </View>
        </View>
      ))}
    </View>
  )
}
