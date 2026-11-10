import { ApprovalDecision, draftOf, type Approval, type SendDraft } from '@vivid/contracts'
import { allowing, draftWords, editedInput, form, riskWords, type DraftWords } from '@vivid/state'
import { Option } from 'effect'
import { Paperclip } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { decideApproval, useApprovalDecision } from '../../data/approvals'
import { Button } from '../../ui/button'
import { cn } from '../../ui/cn'
import { Input } from '../../ui/input'
import { Textarea } from '../../ui/textarea'

/**
 * An Approval decided where the Person finds it, without opening its Thread: on the Feed, under
 * Needs you, and in Notifications (#129). It says what Vivid would do, why, and how much it can
 * change, and offers the two answers. A send is shown as the message it is, a draft the Person
 * can edit and then send (the owner, 27 October 2026: "wants to send, needs a draft to send").
 *
 * Every answer is `DecideApproval` with the digest of the record on screen, the same call the
 * Thread's banner makes, so the server's digest and staleness checks hold here as there (#167).
 * "Always allow" stays in the Thread, where the rule it writes can be read in context.
 *
 * `room` is the space it is drawn in: a Feed card gives the message room to be read whole; the
 * notifications panel is a narrow popover, where the words start shorter and grow as typed.
 */
export function Decide({ approval, room }: { approval: Approval; room: 'card' | 'panel' }) {
  const reading = useApprovalDecision()
  const held = allowing.isWaiting(reading)
  const sending = allowing.sendingOn(reading, approval.id)
  /** Whether the decision on its way is this answer: only its own button says it is going. */
  const going = (tag: ApprovalDecision['_tag']) =>
    Option.exists(sending, (decision) => decision._tag === tag)
  const refusal = allowing.refusalFor(reading, approval.id)
  const decide = (decision: ApprovalDecision) =>
    decideApproval({ id: approval.id, digest: approval.digest, decision })
  const { action } = approval
  // An Integration's paused call is answered as it was asked: the server refuses an edit to it,
  // so it is never offered as a draft.
  const draft = form.isIntegrationApproval(approval) ? Option.none() : draftOf(action)
  return (
    <div className="flex flex-col">
      {/* What Vivid would do, in its own sentence, then why, then how much it can change. */}
      <p
        dir="auto"
        className={cn(
          'text-pretty wrap-anywhere text-ink',
          room === 'card' ? 'mt-2 text-title' : 'mt-1 text-label font-title',
        )}
      >
        {action.summary}
      </p>
      {action.rationale.trim() !== '' && (
        <p dir="auto" className="mt-1 text-label text-pretty wrap-anywhere text-ink-2">
          {action.rationale}
        </p>
      )}
      <p className="mt-1.5 text-meta font-meta text-ink-3">
        <span className={action.effect === 'destructive' ? 'text-danger' : undefined}>
          {riskWords(action.effect)}
        </span>
      </p>
      {Option.match(draft, {
        onSome: (draft) => (
          <DraftForm
            // A newer record of the same ask is a new draft: the words start again from it.
            key={`${approval.id}:${approval.digest}`}
            draft={draft}
            room={room}
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
            <footer className="mt-3 flex justify-end gap-2">
              <Button
                variant="secondary"
                disabled={held}
                onClick={() => decide(ApprovalDecision.cases.Deny.make({}))}
              >
                Don’t allow
              </Button>
              <Button
                disabled={held}
                onClick={() => decide(ApprovalDecision.cases.AllowOnce.make({}))}
              >
                {going('AllowOnce') ? 'Allowing…' : 'Allow'}
              </Button>
            </footer>
          </>
        ),
      })}
    </div>
  )
}

/** Why the last decision on this Approval did not go through, where its buttons are. */
function Refusal({ refusal }: { refusal: Option.Option<string> }) {
  return Option.match(refusal, {
    onNone: () => null,
    onSome: (words) => (
      <p role="alert" className="mt-3 text-label text-danger">
        {words}
      </p>
    ),
  })
}

/**
 * The message as a mail client lays one out: who it goes to and the subject on labelled lines,
 * what is attached, then the words. Each is editable until Send; what is attached is shown and not
 * changed here. Send carries the Person's words when they changed any (`editedInput`), and
 * Discard declines the Approval, so nothing is sent.
 */
function DraftForm({
  draft,
  room,
  held,
  sending,
  discarding,
  refusal,
  onDiscard,
  onSend,
}: {
  draft: SendDraft
  room: 'card' | 'panel'
  held: boolean
  sending: boolean
  discarding: boolean
  refusal: Option.Option<string>
  onDiscard: () => void
  onSend: (words: DraftWords) => void
}) {
  const [words, setWords] = useState(() => draftWords(draft))
  const id = useId()
  const empty = words.to.trim() === '' || words.body.trim() === ''
  return (
    <form
      aria-label="Draft"
      className="mt-3 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!empty) onSend(words)
      }}
    >
      <p className="text-meta font-meta text-ink-3">From {draft.account}</p>
      <Line label="To" id={`${id}-to`}>
        <Input
          id={`${id}-to`}
          compact
          dir="auto"
          disabled={held}
          value={words.to}
          onChange={(event) => setWords({ ...words, to: event.target.value })}
        />
      </Line>
      {Option.isSome(draft.subject) && (
        <Line label="Subject" id={`${id}-subject`}>
          <Input
            id={`${id}-subject`}
            compact
            dir="auto"
            disabled={held}
            value={words.subject}
            onChange={(event) => setWords({ ...words, subject: event.target.value })}
          />
        </Line>
      )}
      {draft.attachments.length > 0 && (
        <ul aria-label="Attached" className="flex flex-wrap gap-x-3 gap-y-1 ps-16">
          {draft.attachments.map((name) => (
            <li key={name} className="inline-flex min-w-0 items-center gap-1 text-label text-ink-2">
              <Paperclip aria-hidden className="size-3.5 shrink-0 text-ink-3" />
              <span className="min-w-0 truncate" title={name}>
                {name}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Textarea
        aria-label="Message"
        dir="auto"
        disabled={held}
        value={words.body}
        onChange={(event) => setWords({ ...words, body: event.target.value })}
        className={room === 'card' ? 'max-h-96 min-h-28' : 'max-h-56 min-h-20'}
      />
      <Refusal refusal={refusal} />
      <footer className="mt-1 flex items-center justify-end gap-2">
        {empty && (
          <p className="me-auto text-label text-ink-3">
            {words.to.trim() === '' ? 'Add who it goes to.' : 'Write the message.'}
          </p>
        )}
        <Button type="button" variant="secondary" disabled={held} onClick={onDiscard}>
          {discarding ? 'Discarding…' : 'Discard'}
        </Button>
        <Button type="submit" disabled={held || empty}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </footer>
    </form>
  )
}

/** One labelled line of the draft: the label in a fixed column, so the fields line up. */
function Line({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-14 shrink-0 text-label text-ink-3">
        {label}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
