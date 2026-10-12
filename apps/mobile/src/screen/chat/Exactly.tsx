import { ActionTarget } from '@vivid/contracts'
import type { Schema } from 'effect'
import type { ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { browserStep, desktopStep } from '@vivid/state'
import { fieldName, fieldsOf, Shown, shownAs } from '../../data/action'
import { Label, MONO } from '../../ui/ui'

/**
 * Exactly what an Approval would allow, in full.
 *
 * An Approval is consent to one specific action, and the decision the phone sends back quotes the
 * digest of all of it. So this shows that action and not a summary of it: the account it would
 * use and every field as it would be sent (who it goes to, the subject, the whole message), the
 * whole command, or a step in the browser or on the desktop in the words every surface uses for
 * it (`@vivid/state`). The phone once showed one line here, cut off after two rows, and none of
 * a Connection's fields: a recipient, a message or the end of a command could be allowed without
 * ever having been on screen.
 *
 * It is drawn in the Approval's banner over the composer (`Allow.tsx`), behind "Details". No
 * word of it is cut short: the text wraps, and the box it is in (`Well`) is at most
 * `WELL.tallest` points tall and scrolls inside, as the detail of the reference's approval does
 * (T3 Code web `ComposerPendingApprovalPanel.tsx`, `max-h-20 overflow-auto`). Until 12 October
 * 2026 it was laid out whole in a card in the conversation, which grew with it.
 */
export function Exactly({ target }: { target: ActionTarget }) {
  return ActionTarget.match(target, {
    Connection: ({ account, tool, input }) => (
      <Sending account={account} tool={tool} input={input} />
    ),
    Browser: ({ action }) => <Step text={browserStep(action)} />,
    Desktop: ({ action }) => <Step text={desktopStep(action)} />,
  })
}

/**
 * What a Connection would be sent: the account and the tool it would use, in full, then every
 * field of the input under its own name.
 */
function Sending({ account, tool, input }: { account: string; tool: string; input: Schema.Json }) {
  return (
    <Well>
      {/* In full and wrapping: the account is where the action lands. */}
      <Label selectable size="label" tone="ink-2">
        {account}
        <Label size="label" tone="ink-2">{` · ${fieldName(tool)}`}</Label>
      </Label>
      <View style={{ paddingTop: 8, gap: 8 }}>
        {fieldsOf(input).map(([key, value]) => (
          <Field key={key} name={key} value={value} />
        ))}
      </View>
    </Well>
  )
}

/** A command, or a step on Vivid's Computer, exactly as it would run: wrapping, never cut. */
function Step({ text }: { text: string }) {
  return (
    <Well>
      <Label selectable size="label" tone="ink-2" style={{ fontFamily: MONO }}>
        {text}
      </Label>
    </Well>
  )
}

/**
 * The most the action is tall before it scrolls inside. The reference's detail is 80 px of
 * 12 px type, about five lines; five of the phone's lines are 110 points.
 */
const TALLEST = 110

/**
 * What holds the action, under the sentence that describes it: plain lines on the banner's own
 * surface, which scroll inside when they are taller than `TALLEST`. Until 12 October 2026 this
 * was a filled box with a mark and a ruled head, a card inside the banner, which the owner had
 * rejected ("too much card nesting"); the web's detail is plain lines too. Its scroll bar stays
 * in sight on Android (`persistentScrollbar`), since nothing else says there is more below; iOS
 * shows its own only while it is scrolled. It scrolls inside the banner's own scroller, so it
 * is told it is nested.
 */
function Well({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      bounces={false}
      nestedScrollEnabled
      persistentScrollbar
      keyboardShouldPersistTaps="handled"
      style={{ maxHeight: TALLEST, flexGrow: 0 }}
    >
      {children}
    </ScrollView>
  )
}

/**
 * One field of a Connection's input: its name as a person reads it, and its value underneath.
 * The key it is sent under was beside the name in mono until 12 October 2026 ("Question
 * question"): a developer's detail.
 */
function Field({ name, value }: { name: string; value: Schema.Json }) {
  return (
    <View style={{ gap: 2 }}>
      <Label size="caption" tone="ink-2">
        {fieldName(name)}
      </Label>
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
            <Label size="label" tone="ink-2" style={{ fontVariant: ['tabular-nums'] }}>
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
