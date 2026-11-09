import { ApprovalDecision, draftOf, type Approval, type SendDraft } from '@vivid/contracts'
import { allowing, draftWords, editedInput, riskWords, type DraftWords } from '@vivid/state'
import { Option } from 'effect'
import { Paperclip } from 'lucide-react-native'
import { useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { decideApproval, useApprovalDecision } from '../../data/approvals'
import { useLiveData } from '../../data/live'
import { useTheme } from '../../theme'
import { Field, Label } from '../../ui/ui'

/**
 * An Approval decided where the Person finds it, without opening its Thread: in a Feed card under
 * Needs you, and in Notifications (#129). The web draws the same (`apps/web/src/screen/feed/
 * Decide.tsx`): what Vivid would do, why, how much it can change, and the two answers; a send is
 * the message it is, a draft to edit and then send (the owner, 27 October 2026: "wants to send,
 * needs a draft to send").
 *
 * Every answer is `DecideApproval` with the digest of the record on screen, as the Thread's
 * banner sends it, so the server's digest and staleness checks hold here too (#167).
 */
export function Decide({ approval }: { approval: Approval }) {
  const data = useLiveData()
  const reading = useApprovalDecision()
  const held = allowing.isWaiting(reading)
  const sending = allowing.sendingOn(reading, approval.id)
  /** Whether the decision on its way is this answer: only its own button says it is going. */
  const going = (tag: ApprovalDecision['_tag']) =>
    Option.exists(sending, (decision) => decision._tag === tag)
  const refusal = allowing.refusalFor(reading, approval.id)
  const decide = (decision: ApprovalDecision) =>
    decideApproval(data, { id: approval.id, digest: approval.digest, decision })
  const { action } = approval
  return (
    <View style={{ marginTop: 8, gap: 4 }}>
      <Label size="body" selectable style={{ fontWeight: '600' }}>
        {action.summary}
      </Label>
      {action.rationale.trim() !== '' && (
        <Label size="label" tone="ink-2" selectable>
          {action.rationale}
        </Label>
      )}
      <Label size="caption" tone={action.effect === 'destructive' ? 'status-danger' : 'ink-3'}>
        {riskWords(action.effect)}
      </Label>
      {Option.match(draftOf(approval.action), {
        onSome: (draft) => (
          <DraftForm
            // A newer record of the same ask is a new draft: the words start again from it.
            key={`${approval.id}:${approval.digest}`}
            draft={draft}
            held={held}
            sending={!going('Deny') && Option.isSome(sending)}
            discarding={going('Deny')}
            refusal={refusal}
            onDiscard={() => decide(ApprovalDecision.cases.Deny.make({}))}
            onSend={(words) =>
              decide(
                Option.match(editedInput(draft, words), {
                  onNone: () => ApprovalDecision.cases.AllowOnce.make({}),
                  onSome: (input) => ApprovalDecision.cases.AllowEdited.make({ input }),
                }),
              )
            }
          />
        ),
        onNone: () => (
          <>
            <Refusal refusal={refusal} />
            <Answers>
              <Answer
                words={going('Deny') ? 'Not allowing…' : 'Don’t allow'}
                primary={false}
                held={held}
                onPress={() => decide(ApprovalDecision.cases.Deny.make({}))}
              />
              <Answer
                words={going('AllowOnce') ? 'Allowing…' : 'Allow'}
                primary
                held={held}
                onPress={() => decide(ApprovalDecision.cases.AllowOnce.make({}))}
              />
            </Answers>
          </>
        ),
      })}
    </View>
  )
}

/** Why the last decision on this Approval did not go through, where its buttons are. */
function Refusal({ refusal }: { refusal: Option.Option<string> }) {
  return Option.match(refusal, {
    onNone: () => null,
    onSome: (words) => (
      <Label
        size="label"
        tone="status-danger"
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        selectable
        style={{ marginTop: 8 }}
      >
        {words}
      </Label>
    ),
  })
}

/**
 * The message laid out as a mail app lays one out: who it goes to and the subject on labelled
 * lines, what is attached, then the words. All but the attachments can be edited until Send;
 * Discard declines the Approval, so nothing is sent.
 */
function DraftForm({
  draft,
  held,
  sending,
  discarding,
  refusal,
  onDiscard,
  onSend,
}: {
  draft: SendDraft
  held: boolean
  sending: boolean
  discarding: boolean
  refusal: Option.Option<string>
  onDiscard: () => void
  onSend: (words: DraftWords) => void
}) {
  const [words, setWords] = useState(() => draftWords(draft))
  const empty = words.to.trim() === '' || words.body.trim() === ''
  return (
    <View accessibilityLabel="Draft" style={{ marginTop: 8, gap: 8 }}>
      <Label size="caption" tone="ink-3">
        From {draft.account}
      </Label>
      <Line label="To">
        <Field
          accessibilityLabel="To"
          value={words.to}
          editable={!held}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          onChangeText={(to) => setWords({ ...words, to })}
          style={LINE_FIELD}
        />
      </Line>
      {Option.isSome(draft.subject) && (
        <Line label="Subject">
          <Field
            accessibilityLabel="Subject"
            value={words.subject}
            editable={!held}
            onChangeText={(subject) => setWords({ ...words, subject })}
            style={LINE_FIELD}
          />
        </Line>
      )}
      {draft.attachments.length > 0 && (
        <View
          accessibilityLabel="Attached"
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingLeft: LABEL + 8 }}
        >
          {draft.attachments.map((name) => (
            <Attached key={name} name={name} />
          ))}
        </View>
      )}
      <Field
        accessibilityLabel="Message"
        value={words.body}
        multiline
        editable={!held}
        onChangeText={(body) => setWords({ ...words, body })}
        style={{ minHeight: 140, maxHeight: 320, textAlignVertical: 'top' }}
      />
      <Refusal refusal={refusal} />
      {empty && (
        <Label size="label" tone="ink-3">
          {words.to.trim() === '' ? 'Add who it goes to.' : 'Write the message.'}
        </Label>
      )}
      <Answers>
        <Answer
          words={discarding ? 'Discarding…' : 'Discard'}
          primary={false}
          held={held}
          onPress={onDiscard}
        />
        <Answer
          words={sending ? 'Sending…' : 'Send'}
          primary
          held={held || empty}
          onPress={() => onSend(words)}
        />
      </Answers>
    </View>
  )
}

/** The width of a draft line's label, so the fields line up under each other. */
const LABEL = 56

/** A draft's one-line field: as tall as a card's buttons, so the form reads as one block. */
const LINE_FIELD = { minHeight: 40, paddingVertical: 8, paddingHorizontal: 12 } as const

/** One labelled line of the draft. */
function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Label size="label" tone="ink-3" style={{ width: LABEL }}>
        {label}
      </Label>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  )
}

/** One attached file, by name, read only. */
function Attached({ name }: { name: string }) {
  const { colors: c } = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' }}>
      <Paperclip size={14} strokeWidth={1.8} color={c['ink-3']} />
      <Label size="label" tone="ink-2" numberOfLines={1} style={{ flexShrink: 1 }}>
        {name}
      </Label>
    </View>
  )
}

/** The answers' row, at the foot of the card as a said card's buttons are (`Feed.tsx`). */
function Answers({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>{children}</View>
}

/**
 * One answer, painted as a Feed card's own buttons are (`Choice`, `Feed.tsx`: 40 points, 12
 * corners, the accent for the answer and its soft tint for the way out), so a card decided here
 * reads as one of the Feed's.
 */
function Answer({
  words,
  primary,
  held,
  onPress,
}: {
  words: string
  primary: boolean
  held: boolean
  onPress: () => void
}) {
  const { colors: c } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: held }}
      disabled={held}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: primary ? 1 : undefined,
        minWidth: 0,
        height: 40,
        borderRadius: 12,
        borderCurve: 'continuous',
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: primary ? c.accent : c['accent-soft'],
        opacity: held ? 0.5 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Label
        size="body"
        tone={primary ? 'ink-on-accent' : 'ink'}
        numberOfLines={1}
        style={{ fontWeight: primary ? '600' : '500' }}
      >
        {words}
      </Label>
    </Pressable>
  )
}
