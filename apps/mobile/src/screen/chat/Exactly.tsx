import { ActionTarget } from '@vivid/contracts'
import type { Schema } from 'effect'
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { Globe, Link2, Monitor, Terminal, type LucideIcon } from 'lucide-react-native'
import { browserStep, desktopStep } from '@vivid/state'
import { fieldName, fieldsOf, Shown, shownAs } from '../../data/action'
import { useTheme } from '../../theme'
import { HAIRLINE, Label, MONO, radius } from '../../ui/ui'

/**
 * Exactly what an Approval would allow, in full.
 *
 * An Approval is consent to one specific action, and the decision the phone sends back quotes the
 * digest of all of it. So the card shows that action and not a summary of it: the account it would
 * use and every field as it would be sent (who it goes to, the subject, the whole message), the
 * whole command, or a step in the browser or on the desktop in the words every surface uses for
 * it (`@vivid/state`). The phone used to show one line here, cut off after two rows, and none of
 * a Connection's fields: a recipient, a message or the end of a command could be allowed without
 * ever having been on screen.
 *
 * Nothing here is cut short or scrolls on its own. The text wraps and the card grows, so the
 * conversation's own scroll carries the Person through all of it before they reach the buttons
 * underneath. The same rules as the web card (`apps/web/src/screen/thread/Cards.tsx`).
 */
export function Exactly({ target }: { target: ActionTarget }) {
  return ActionTarget.match(target, {
    Connection: ({ account, tool, input }) => (
      <Sending account={account} tool={tool} input={input} />
    ),
    Command: ({ command }) => <Step icon={TARGET_ICON.Command} text={command} />,
    Browser: ({ action }) => <Step icon={TARGET_ICON.Browser} text={browserStep(action)} />,
    Desktop: ({ action }) => <Step icon={TARGET_ICON.Desktop} text={desktopStep(action)} />,
  })
}

/**
 * What a Connection would be sent: the account and the tool it would use, in full, then every
 * field of the input under its own name.
 */
function Sending({ account, tool, input }: { account: string; tool: string; input: Schema.Json }) {
  return (
    <Well>
      <Line icon={TARGET_ICON.Connection} ruled>
        {/* In full and wrapping: the account is where the action lands. */}
        <Label selectable size="label" tone="ink-2" style={{ flex: 1 }}>
          {account}
          <Label size="label" tone="ink-3">{` · ${tool}`}</Label>
        </Label>
      </Line>
      <View style={{ paddingHorizontal: INSET, paddingVertical: 10, gap: 10 }}>
        {fieldsOf(input).map(([key, value]) => (
          <Field key={key} name={key} value={value} />
        ))}
      </View>
    </Well>
  )
}

/** A command, or a step on Vivid's Computer, exactly as it would run: wrapping, never cut. */
function Step({ icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <Well>
      <Line icon={icon} ruled={false}>
        <Label selectable size="label" tone="ink-2" style={{ flex: 1, fontFamily: MONO }}>
          {text}
        </Label>
      </Line>
    </Well>
  )
}

/** The mark for each kind of thing an action is done to; a new kind fails to compile here. */
const TARGET_ICON = {
  Connection: Link2,
  Command: Terminal,
  Browser: Globe,
  Desktop: Monitor,
} as const satisfies Record<ActionTarget['_tag'], LucideIcon>

/** The space between the well's edge and what is in it, on either side. */
const INSET = 10

/** The sunk surface the action sits in, set apart from the sentence that describes it. */
function Well({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        // Tighter than the card's own corners, which it sits inside.
        borderRadius: radius.card - 10,
        backgroundColor: c['surface-well'],
        // The rule under a Connection's account stops at the rounded corners.
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  )
}

/**
 * The mark of what the action is done to, and beside it the words that say so. The mark stays on
 * the first line however many lines the words wrap to. `ruled` draws the line that separates a
 * Connection's account from its fields.
 */
function Line({
  icon: Icon,
  ruled,
  children,
}: {
  icon: LucideIcon
  ruled: boolean
  children: ReactNode
}) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingHorizontal: INSET,
        paddingVertical: 8,
        borderBottomWidth: ruled ? HAIRLINE : 0,
        borderBottomColor: c['line-2'],
      }}
    >
      {/* A 15-point mark centred on the first 18-point line of the words beside it. */}
      <View style={{ marginTop: 1.5 }}>
        <Icon size={15} strokeWidth={1.7} color={c['ink-3']} />
      </View>
      {children}
    </View>
  )
}

/**
 * One field of a Connection's input: its name as a person reads it, the key it is actually sent
 * under beside that, and its value underneath.
 */
function Field({ name, value }: { name: string; value: Schema.Json }) {
  return (
    <View style={{ gap: 2 }}>
      <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 6 }}
      >
        <Label size="caption" tone="ink-3">
          {fieldName(name)}
        </Label>
        <Label size="caption" tone="ink-3" style={{ fontFamily: MONO }}>
          {name}
        </Label>
      </View>
      <Value value={value} />
    </View>
  )
}

/**
 * One value as it will be sent, drawn by what kind of value it is (`shownAs`): words as words,
 * anything that is not words set apart in the fixed-width face, and a list one numbered item to a
 * line, each item drawn the same way. It can be selected, so an address can be checked elsewhere.
 */
function Value({ value }: { value: Schema.Json }) {
  return Shown.$match(shownAs(value), {
    Text: ({ text }) => (
      <Label selectable size="label">
        {text}
      </Label>
    ),
    Literal: ({ text }) => (
      <Label selectable size="label" tone="ink-2" style={{ fontFamily: MONO }}>
        {text}
      </Label>
    ),
    List: ({ items }) => (
      <View style={{ gap: 2 }}>
        {items.map((item, position) => (
          // A list's items have no identity but their place, and the list is drawn once.
          // oxlint-disable-next-line react/no-array-index-key
          <View key={position} style={{ flexDirection: 'row', gap: 8 }}>
            <Label size="label" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
              {position + 1}.
            </Label>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Value value={item} />
            </View>
          </View>
        ))}
      </View>
    ),
  })
}
