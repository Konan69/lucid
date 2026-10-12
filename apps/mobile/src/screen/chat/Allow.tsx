import type { MenuAction } from '@react-native-menu/menu'
import { ActionTarget, ApprovalDecision } from '@vivid/contracts'
import { APPROVAL_EFFECT_WORDS, asking, type ApprovalUp } from '@vivid/state'
import { nativeMetrics as m } from '@vivid/tokens/native'
import { Option } from 'effect'
import { ChevronDown, Ellipsis, Shield } from 'lucide-react-native'
import { useState } from 'react'
import { ScrollView, View, type Insets } from 'react-native'
import Animated, { useReducedMotion, type SharedValue } from 'react-native-reanimated'
import { ControlPillMenu } from '../../t3/Menu'
import { useTheme } from '../../theme'
import { EDGE, Label, Press } from '../../ui/ui'
import { Attached, FOLD, MARK, STANDING_BACK, Surface, useSlide, useTallest } from './Banner'
import { Exactly } from './Exactly'

/**
 * A decision's buttons: their least height, how far past their drawn edge they are pressed
 * above and below (34 and 5 either way is the 44 a finger needs), the room between two of them,
 * which is the reference's `gap-1.5`, and how far each is pressed into that room: half of it, so
 * no point between two buttons belongs to both.
 */
const ACT = { height: 34, reach: 5, gap: 6, between: 3 } as const

/**
 * "Details": drawn 30 points tall and pressed 44. Its reach below and a button's reach above
 * are together the 12 points between the two rows (the reference's `gap-y-3`), so the two
 * targets meet and do not overlap. That room is kept inside the views that hold each control
 * (`Proposal`, `Decision`) and is not slop outside them: Android sends no touch to a control
 * outside its parent.
 */
const DETAILS = { height: 30, reach: 7 } as const

/** The most lines of the summary the banner shows. All of it is in the Thread (`Cards.tsx`). */
const SUMMARY_LINES = 3

/**
 * How much more readily the account gives up width than the words beside it: it shrinks to
 * nothing before the effect's words lose a point.
 */
const SHRINKS_FIRST = 1000

interface AllowProps {
  /** The Approval the banner holds, and how many are waiting on this Person with it. */
  readonly up: ApprovalUp
  /** It is no longer the one that is up: the banner slides away and then says so (`onGone`). */
  readonly leaving: boolean
  /** A decision is on its way: nothing more can be decided until that try ends. */
  readonly busy: boolean
  /** The measured height of the composer's dock, which the banner is anchored to. */
  readonly dock: number
  /** Written with how far the banner stands over the foot of the conversation (`useSlide`). */
  readonly covered: SharedValue<number>
  readonly onDecide: (decision: ApprovalDecision) => void
  /** The banner has slid away. */
  readonly onGone: () => void
}

/**
 * Something Vivid will not do without a yes, as a banner attached to the top of the composer
 * while it waits on the Person looking at it. It is the banner a question has (`Choices.tsx`),
 * on the same surface, window and slide (`Banner.tsx`), and it takes the question's place while
 * both wait: an Approval comes first (`screen/Chat.tsx`). What Vivid asked stays in the
 * conversation as its own words (`Cards.tsx`), with how it ended.
 *
 * It is a port of T3 Code web's approval banner (`ChatComposer.tsx`, the `activePendingApproval`
 * branch: `ComposerBanner.Root` with `variant="warning"` and `density="spacious"`, a `Row` with
 * `layout="approval"`, `ComposerPendingApprovalPanel.tsx`, `ComposerPendingApprovalActions.tsx`).
 * Kept from it:
 * - the warning surface, and 12 points of room inside it;
 * - a shield in the leading column, in the warning colour;
 * - beside it a small line (what kind of thing this is, in the warning colour; where it lands;
 *   "1/n" at the far end only when more than one waits), then what is asked, in the ink;
 * - the detail in a box at most 80 points tall that scrolls inside (`Exactly.tsx`);
 * - the buttons on a row of their own under that, at the trailing end, as the reference lays
 *   them out in anything narrower than 560 px: the lesser answers behind an ellipsis that
 *   opens a menu, an outline button to refuse and a filled one to allow. All of them stand back
 *   while a decision is on its way.
 *
 * Where Vivid's differs, and why:
 * - The small line's words are the action's effect (`APPROVAL_EFFECT_WORDS`) and the account a
 *   Connection would use, where the reference names a kind of request and an app.
 * - What is asked is the action's summary, on up to three lines. Exactly what would be done is
 *   closed behind "Details" until asked for, where the reference shows its one detail at once:
 *   a Connection's fields are longer than a command.
 * - The ellipsis comes first and opens the system's menu (`t3/Menu.tsx`). The menu coming up
 *   under the finger is its press's feedback: on iOS the system's own button lies over what
 *   the menu wraps, so nothing under it is ever pressed.
 * - A decision that did not go through is said over the composer (`screen/Chat.tsx`), as a
 *   question's is, and not in the banner.
 */
export function Allow({ up, leaving, busy, dock, covered, onDecide, onGone }: AllowProps) {
  const tallest = useTallest(dock)
  const slide = useSlide(asking.standOf(leaving, false), covered, onGone)
  return (
    <Attached dock={dock} tallest={tallest} leaving={leaving} slide={slide}>
      <Surface tallest={tallest} variant="warning" density="spacious">
        <Proposal up={up} />
        <Decision
          // A banner that is leaving was settled, here or anywhere else.
          reach={leaving || busy ? 'held' : 'pressable'}
          busy={busy}
          onDecide={onDecide}
        />
      </Surface>
    </Attached>
  )
}

/** The account an action would use, when it is done through a Connection. */
const accountOf = (target: ActionTarget): Option.Option<string> =>
  ActionTarget.match(target, {
    Connection: ({ account }) => Option.some(account),
    Browser: () => Option.none(),
    Desktop: () => Option.none(),
  })

/**
 * What is asked: the shield, and beside it the small line, the summary and the way to exactly
 * what would be done. It is in a scroller that gives way when the banner has reached its most
 * height (a small phone with the keyboard up, the largest text), so the buttons under it are
 * always in sight; when everything fits, which is nearly always, nothing scrolls.
 *
 * The summary wraps and is never cut to one line: three lines at most, then an ellipsis. Text
 * breaks inside a word that is longer than a line, and the system sets right-to-left words from
 * the right. Whether the detail is open is the banner's own and starts closed for each Approval
 * (the banner is keyed by it, `screen/Chat.tsx`).
 */
function Proposal({ up }: { up: ApprovalUp }) {
  const { colors: c } = useTheme()
  const { action } = up.approval
  const [open, setOpen] = useState(false)
  return (
    <ScrollView
      bounces={false}
      nestedScrollEnabled
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={{ flexGrow: 0, flexShrink: 1 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        {/* The reference's icon: 16 px, two under the top of its row. */}
        <View style={{ width: MARK, paddingTop: 2, alignItems: 'center' }}>
          <Shield pointerEvents="none" size={16} strokeWidth={2} color={c['status-approve']} />
        </View>
        {/* Its foot is the room "Details" is pressed in (`DETAILS`). */}
        <View style={{ flex: 1, minWidth: 0, gap: 4, paddingBottom: DETAILS.reach }}>
          <Kind up={up} />
          <Label size="footnote" numberOfLines={SUMMARY_LINES} style={{ lineHeight: 18 }}>
            {action.summary}
          </Label>
          <Details open={open} onToggle={() => setOpen(!open)} />
          {open && <Exactly target={action.target} />}
        </View>
      </View>
    </ScrollView>
  )
}

/**
 * The small line: what the action can change, in the approval colour; the account it would use,
 * when it has one; and at the far end which of the waiting Approvals this is, only when there
 * is more than one. The banner always holds the oldest, so that is "1/n".
 *
 * The account is one line and is what gives way: it shrinks to an ellipsis before the effect's
 * words lose any width (`SHRINKS_FIRST`), and the count never shrinks. Should the effect's
 * words still not fit (the largest text on a narrow phone) they wrap; they are never cut.
 */
function Kind({ up }: { up: ApprovalUp }) {
  const { action } = up.approval
  const account = accountOf(action.target)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', columnGap: 8 }}>
      <Label
        size="micro"
        tone="status-approve"
        style={{ flexShrink: 1, fontWeight: m['weight-title'] }}
      >
        {APPROVAL_EFFECT_WORDS[action.effect]}
      </Label>
      {Option.isSome(account) && (
        <Label
          size="micro"
          tone="ink-2"
          numberOfLines={1}
          ellipsizeMode="tail"
          style={{ flexShrink: SHRINKS_FIRST, minWidth: 0 }}
        >
          {account.value}
        </Label>
      )}
      {up.waiting > 1 && (
        <Label
          size="micro"
          tone="ink-3"
          accessibilityLabel={`1 of ${up.waiting} waiting on you`}
          style={{
            marginStart: 'auto',
            flexShrink: 0,
            fontWeight: m['weight-title'],
            fontVariant: ['tabular-nums'],
          }}
        >
          {`1/${up.waiting}`}
        </Label>
      )}
    </View>
  )
}

/**
 * The way to exactly what would be done: a quiet word and a chevron that turns over while the
 * detail is open, as a question's head does. It takes the wash under a finger and sinks. Its
 * fill reaches 8 points past its words on either side, and it is pulled back by as much at its
 * start so the word stands under the summary.
 */
function Details({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { colors: c } = useTheme()
  const still = useReducedMotion()
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={
        open ? 'Hide exactly what will be done' : 'Show exactly what will be done'
      }
      accessibilityState={{ expanded: open }}
      hitSlop={{ top: DETAILS.reach, bottom: DETAILS.reach }}
      onPress={onToggle}
      containerStyle={{ alignSelf: 'flex-start', marginStart: -8 }}
      style={({ pressed }) => ({
        minHeight: DETAILS.height,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        borderRadius: 8,
        borderCurve: 'continuous',
        backgroundColor: pressed ? c['wash-hover'] : 'transparent',
      })}
    >
      <Label size="caption" tone="ink-2" style={{ fontWeight: m['weight-title'] }}>
        Details
      </Label>
      <Animated.View
        style={{
          transform: [{ rotate: open ? '180deg' : '0deg' }],
          transitionProperty: 'transform',
          transitionDuration: still ? 0 : FOLD,
          transitionTimingFunction: 'ease-out',
        }}
      >
        <ChevronDown pointerEvents="none" size={14} strokeWidth={2.2} color={c['ink-3']} />
      </Animated.View>
    </Press>
  )
}

/** Whether the banner's buttons can be pressed, or are there but out of reach. */
type Reach = 'pressable' | 'held'

/** The one answer behind the ellipsis. The menu answers with a row's id, which is text. */
const ALWAYS = 'always'
const MORE: MenuAction[] = [{ id: ALWAYS, title: 'Always allow' }]

/**
 * The answers, at the trailing end of a row of their own: the ellipsis, "Don’t allow" and
 * "Allow". "Allow" allows this once; allowing the same kind of action from now on is the one
 * answer behind the ellipsis. They wrap onto a second line if the largest text leaves no room
 * for them side by side, and they stand back together while a decision is on its way.
 *
 * The row holds the room its buttons are pressed in above and below (`ACT.reach`); the room
 * below is taken back from the surface's own, so the buttons are drawn where they would be
 * without it.
 */
function Decision({
  reach,
  busy,
  onDecide,
}: {
  reach: Reach
  busy: boolean
  onDecide: (decision: ApprovalDecision) => void
}) {
  return (
    <Animated.View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: ACT.gap,
        paddingVertical: ACT.reach,
        marginBottom: -ACT.reach,
        opacity: busy ? STANDING_BACK : 1,
        transitionProperty: 'opacity',
        transitionDuration: m['dur-fast'],
      }}
    >
      <More reach={reach} onAlways={() => onDecide(ApprovalDecision.cases.AlwaysAllow.make({}))} />
      <Act
        label="Don’t allow"
        kind="outline"
        reach={reach}
        slop={{ top: ACT.reach, bottom: ACT.reach, left: ACT.between, right: ACT.between }}
        onPress={() => onDecide(ApprovalDecision.cases.Deny.make({}))}
      />
      <Act
        label="Allow"
        kind="filled"
        reach={reach}
        // Nothing past its trailing edge: that is the end of the row that holds it.
        slop={{ top: ACT.reach, bottom: ACT.reach, left: ACT.between }}
        onPress={() => onDecide(ApprovalDecision.cases.AllowOnce.make({}))}
      />
    </Animated.View>
  )
}

/**
 * How each kind of button is drawn: the reference's `outline` and `default` (filled) variants
 * in the theme's own colours. An outline button is the plain raised surface inside the solid
 * border and goes a step darker under a finger; the filled one is the primary and dims.
 */
const ACT_PAINT = {
  outline: { ink: 'ink', rest: 'subtle-strong', pressed: 'subtle', line: 'border', dim: 1 },
  filled: { ink: 'ink-on-accent', rest: 'primary', pressed: 'primary', line: 'primary', dim: 0.82 },
} as const

/**
 * One answer, as a pill 34 points tall at least and pressed 44 (`ACT`). Its label is one line.
 * It sinks under a finger (`Press`) and changes its fill, and it is disabled as well as
 * untouchable while out of reach: a switch control reaches a control by other ways than a touch.
 */
function Act({
  label,
  kind,
  reach,
  slop,
  onPress,
}: {
  label: string
  kind: keyof typeof ACT_PAINT
  reach: Reach
  slop: Insets
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  const paint = ACT_PAINT[kind]
  const disabled = reach === 'held'
  return (
    <Press
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={slop}
      onPress={onPress}
      containerStyle={{ maxWidth: '100%' }}
      style={({ pressed }) => ({
        minHeight: ACT.height,
        paddingHorizontal: 14,
        paddingVertical: 6,
        alignItems: 'center',
        justifyContent: 'center',
        // A full pill, as every labelled action in the app is (`ui/ui.tsx`, `Button`).
        borderRadius: 999,
        borderWidth: EDGE,
        borderColor: c[paint.line],
        backgroundColor: c[pressed ? paint.pressed : paint.rest],
        opacity: pressed ? paint.dim : 1,
      })}
    >
      <Label size="label" tone={paint.ink} numberOfLines={1} style={{ fontWeight: '600' }}>
        {label}
      </Label>
    </Press>
  )
}

/**
 * The ellipsis: a round outline button that opens the system's menu with the one lesser answer
 * (`MORE`). It is 34 points across; the menu's own slop makes it 44 tall and, into the free
 * room at its leading side, 47 wide. While the buttons are out of reach it is drawn without its
 * menu, so there is nothing to open.
 */
function More({ reach, onAlways }: { reach: Reach; onAlways: () => void }) {
  const { colors: c } = useTheme()
  const round = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel="More answers"
      accessibilityState={{ disabled: reach === 'held' }}
      style={{
        width: ACT.height,
        height: ACT.height,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: ACT.height / 2,
        borderWidth: EDGE,
        borderColor: c[ACT_PAINT.outline.line],
        backgroundColor: c[ACT_PAINT.outline.rest],
      }}
    >
      <Ellipsis pointerEvents="none" size={16} strokeWidth={2} color={c['ink-2']} />
    </View>
  )
  if (reach === 'held') return round
  return (
    <ControlPillMenu
      actions={MORE}
      hitSlop={{ top: ACT.reach, bottom: ACT.reach, left: 10, right: ACT.between }}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === ALWAYS) onAlways()
      }}
    >
      {round}
    </ControlPillMenu>
  )
}
