import {
  ApprovalDecision,
  type Approval,
  type ApprovalId,
  type InputRequest,
  type PersonId,
} from '@vivid/contracts'
import { approvalUp, asking, form, type ApprovalUp } from '@vivid/state'
import { Data, Effect, Option, Result } from 'effect'
import { useCallback, useId, useReducer, useRef, useState } from 'react'
import { act } from '../../data/app'
import { changing } from '../../data/live'
import { useAsking, type Asking } from './asking'
import { Attached, Head, Panel, Raised, Row, SURFACE, digits, steer, type Reach } from './Choices'
import { Filled } from './Form'

/**
 * Something Vivid wants to do and will not do without a yes, asked the way Vivid asks anything:
 * as a question's banner attached to the top of the composer (`Choices.tsx`), while it waits on
 * the Person looking at it. What it asked is also Vivid's words in the conversation
 * (`AskedFirst`, `Cards.tsx`), with exactly what would be sent, and that is what stays once the
 * banner has gone.
 *
 * It was a port of T3 Code web's pending-approval banner (a tinted surface, a shield, a label
 * for the kind of action, a box of details and three buttons). The owner rejected that as
 * bloated on 12 October 2026 ("highest it should just ask a normal question"): Vivid runs what
 * it is told without asking, so an Approval is rare, and when one is needed it is one more
 * question. So the banner is a question's: the same surface, head and rows, and the three
 * answers are its options. Kept from the reference: while an Approval is up it takes the place
 * of a question's banner (`useAsks`), and nothing can be pressed while a decision is on its way.
 */

/**
 * One try at deciding one Approval. `attempt` tells two tries apart, so that the end of an old
 * one is never taken for the end of the one now on its way.
 */
interface Attempt {
  readonly attempt: number
  readonly id: ApprovalId
}

/**
 * Where deciding stands, for the whole Thread: one Approval is decided at a time.
 *
 * - `Still`: nothing has been pressed.
 * - `Sending`: a decision left for the server. It stays so when the server takes it: it is the
 *   Approval's own record that takes its banner away, not the call returning, so buttons that
 *   woke up between the two could not be pressed a second time.
 * - `Refused`: the server did not take it. The Approval was decided somewhere else, or what it
 *   would do changed; the record on screen is the newer one and can be decided again.
 */
export type Deciding = Data.TaggedEnum<{
  Still: {}
  Sending: { readonly tried: Attempt }
  Refused: { readonly tried: Attempt }
}>
export const Deciding = Data.taggedEnum<Deciding>()

/** What happens to a try: it left for the server, or the server did not take it. */
export type Tried = Data.TaggedEnum<{
  Began: { readonly tried: Attempt }
  Failed: { readonly tried: Attempt }
}>
export const Tried = Data.taggedEnum<Tried>()

/**
 * Where deciding stands after something happened to a try. A try that begins is the one on its
 * way. A try that failed is refused only if it still is the one on its way: the end of a call
 * arrives whenever the server answers, and the end of an older try must not wake the buttons of
 * the Approval being decided now, or say a refusal about it.
 */
export const decidingAfter = (deciding: Deciding, happened: Tried): Deciding =>
  Tried.$match(happened, {
    Began: ({ tried }) => Deciding.Sending({ tried }),
    Failed: ({ tried }) =>
      Deciding.$is('Sending')(deciding) && deciding.tried.attempt === tried.attempt
        ? Deciding.Refused({ tried })
        : deciding,
  })

/** What is said when a decision did not go through. The record on screen is already the newer. */
const REFUSED = 'This was already decided or has changed. Check it again.'

/**
 * What the banner over the composer is doing: nothing, showing the Approval that is up, or
 * folding away one that no longer is. It is `asking.Hold` (`@vivid/state`) for an Approval.
 */
export type Hold = Data.TaggedEnum<{
  Free: {}
  Up: { readonly up: ApprovalUp }
  Leaving: { readonly up: ApprovalUp }
}>
export const Hold = Data.taggedEnum<Hold>()

/**
 * Reads what the banner is doing from the Approval it holds and the one that is up. While they
 * are the same Approval the banner shows the server's newest record of it and the newest count
 * of those waiting; once they differ it keeps what it held until it has folded away.
 */
const holdOf = (held: Option.Option<ApprovalUp>, up: Option.Option<ApprovalUp>): Hold =>
  Option.match(held, {
    onNone: () => Hold.Free(),
    onSome: (kept) =>
      Option.match(
        Option.filter(up, (next) => next.approval.id === kept.approval.id),
        {
          onNone: () => Hold.Leaving({ up: kept }),
          onSome: (current) => Hold.Up({ up: current }),
        },
      ),
  })

/**
 * The Approval whose banner is up over the composer, and deciding it. It is `useAsking`
 * (`asking.ts`) for an Approval, and keeps state the same way.
 *
 * `up` is the Approval that should be up (`approvalUp`, `@vivid/state`). The banner holds one
 * at a time and lets go of it only once it has folded away, so the next one's banner arrives
 * after the last has settled (`holdOf`). What it holds follows `up` while rendering, which is
 * React's own way to follow a value without an effect: a free banner takes what is up.
 *
 * Each press is one `Attempt`, and what ends is that attempt and nothing else (`decidingAfter`):
 * the state is one value moved by what happens to a try, never set from the far side of the
 * call. One Approval also takes one decision at a time. Which have a call in flight is kept in
 * a ref, read when a press happens and never while rendering, because two presses can land
 * before React has drawn the first.
 *
 * The decision quotes the digest of the record it was pressed on, so a banner drawn from an
 * older proposal cannot allow a newer one: the server refuses it, and that is said.
 */
export function useAllowing(up: Option.Option<ApprovalUp>) {
  const [held, setHeld] = useState(up)
  const [deciding, tried] = useReducer(decidingAfter, Deciding.Still())
  const flying = useRef(new Set<ApprovalId>())
  const attempts = useRef(0)
  const hold = holdOf(held, up)
  if (Hold.$is('Free')(hold) && Option.isSome(up)) setHeld(up)
  // One function for the life of the Thread: the banner is handed it, and is not drawn again for
  // a function that only looks new.
  const release = useCallback(() => setHeld(Option.none()), [])

  /** Sends one decision on one Approval, as that Approval's record stood when it was pressed. */
  const decide = useCallback((approval: Approval, decision: ApprovalDecision) => {
    const { id, digest } = approval
    if (flying.current.has(id)) return
    flying.current.add(id)
    attempts.current += 1
    const attempt: Attempt = { attempt: attempts.current, id }
    tried(Tried.Began({ tried: attempt }))
    void act(
      Effect.gen(function* () {
        const result = yield* changing((client) => client.DecideApproval({ id, digest, decision }))
        flying.current.delete(id)
        if (Result.isFailure(result)) tried(Tried.Failed({ tried: attempt }))
      }),
    )
  }, [])

  return {
    hold,
    /** A decision on this Approval is on its way, or was taken and its record is yet to say so. */
    sending: (id: ApprovalId) => Deciding.$is('Sending')(deciding) && deciding.tried.id === id,
    /** What to say when the last decision on this Approval did not go through. */
    refusalOf: (id: ApprovalId): Option.Option<string> =>
      Deciding.$is('Refused')(deciding) && deciding.tried.id === id
        ? Option.some(REFUSED)
        : Option.none(),
    decide,
    release,
  }
}

/** What `useAllowing` answers with: what the banner is given. */
export type Allowing = ReturnType<typeof useAllowing>

/**
 * Everything Vivid is asking of this Person over the composer, one banner at a time: an
 * Approval first, then a question (the reference shows its pending approval in place of its
 * pending question, `ChatComposer.tsx`).
 *
 * While an Approval is up, or its banner is still folding away, no question is up as far as the
 * Thread is concerned: its banner is not drawn, the composer's button does not move on from it
 * and the composer says "Message Vivid". The question is not withdrawn by that, and where the
 * Person was in it is kept (`useAsking`); its banner rises when the last Approval has settled
 * and gone. The other way round, an Approval that arrives while a question's banner is up is
 * held at once but drawn only when that banner has folded away (`Asks`), so two banners are
 * never over the composer together. One that is settled before it was ever drawn is let go of
 * here and now: a banner says it has gone when its fold ends, and one that was never on screen
 * has no fold to end, so it would hold the place over the composer for good.
 */
export function useAsks(
  approvals: ReadonlyArray<Approval>,
  requests: ReadonlyArray<InputRequest>,
  me: PersonId,
) {
  const up = approvalUp(approvals, me)
  const allowing = useAllowing(up)
  const first = Option.isSome(up) || !Hold.$is('Free')(allowing.hold)
  const asked = useAsking(first ? Option.none() : asking.upOf(requests, me))
  const undrawn = !asking.Hold.$is('Free')(asked.hold)
  if (undrawn && Hold.$is('Leaving')(allowing.hold)) allowing.release()
  return { allowing, asked }
}

/**
 * The one banner over the composer (`useAsks`): a question's while that banner holds anything,
 * its last fold included, and otherwise the Approval's, when one is held.
 */
export function Asks({ allowing, asked }: { allowing: Allowing; asked: Asking }) {
  return asking.Hold.$match(asked.hold, {
    Free: () => <Allowed allowing={allowing} />,
    Up: ({ request }) => <Question asked={asked} request={request} leaving={false} />,
    Leaving: ({ request }) => <Question asked={asked} request={request} leaving />,
  })
}

/**
 * A question's banner: an Integration's form (`Form.tsx`) when the request is an Integration's
 * mid-call question, and otherwise Vivid's own question (`Choices.tsx`).
 */
function Question({
  asked,
  request,
  leaving,
}: {
  asked: Asking
  request: InputRequest
  leaving: boolean
}) {
  if (request.integration === null) return <Raised asking={asked} />
  return <Filled key={request.id} request={request} leaving={leaving} onGone={asked.release} />
}

/**
 * The banner over the composer, for what it holds (`useAllowing`): the Approval that is up, or
 * the one folding away. It is keyed by the Approval, so each one's banner arrives open, with
 * no row chosen.
 */
export function Allowed({ allowing }: { allowing: Allowing }) {
  const drawn = Hold.$match(allowing.hold, {
    Free: () => Option.none(),
    Up: ({ up }) => Option.some({ up, leaving: false }),
    Leaving: ({ up }) => Option.some({ up, leaving: true }),
  })
  if (Option.isNone(drawn)) return null
  const { approval, waiting } = drawn.value.up
  const { leaving } = drawn.value
  return (
    <Attached
      key={approval.id}
      leaving={leaving}
      refusal={allowing.refusalOf(approval.id)}
      onGone={allowing.release}
    >
      <Allow
        approval={approval}
        waiting={waiting}
        // An Approval that has just been settled, here or anywhere else, cannot be decided; nor
        // can one whose decision is on its way.
        held={leaving || allowing.sending(approval.id)}
        onDecide={(decision) => allowing.decide(approval, decision)}
      />
    </Attached>
  )
}

/**
 * The three answers, as a question's options, in the order they are offered. "Allow" is for this
 * once; "Always allow" also writes the Person's rule, so the same kind of action does not ask
 * again (`ApprovalDecision`, `packages/contracts`), which its second line says.
 */
const ANSWERS = [
  { option: { label: 'Allow', detail: '' }, decision: ApprovalDecision.cases.AllowOnce.make({}) },
  {
    option: { label: 'Always allow', detail: 'Vivid won’t ask again for this' },
    decision: ApprovalDecision.cases.AlwaysAllow.make({}),
  },
  { option: { label: 'Don’t allow', detail: '' }, decision: ApprovalDecision.cases.Deny.make({}) },
] as const

/**
 * The answers an Approval offers. An Integration that paused its call asks every time and takes
 * only Allow and Don't allow (`form.isIntegrationApproval`, `@vivid/state`), so it has no
 * "Always allow".
 */
const answersOf = (approval: Approval) =>
  form.isIntegrationApproval(approval)
    ? ANSWERS.filter((answer) => !ApprovalDecision.guards.AlwaysAllow(answer.decision))
    : ANSWERS

/**
 * An Approval, drawn as a question: the head a question's banner has, saying what Vivid would
 * do, and under it the three answers as a question's rows. The head closes and opens the rows,
 * and says "1/3" when more than one Approval waits on this Person.
 *
 * Which row was pressed is kept here only to show it chosen while its decision is on its way:
 * once nothing is held any more and the Approval is still up, the decision did not go through,
 * and no row is shown as chosen.
 */
function Allow({
  approval,
  waiting,
  held,
  onDecide,
}: {
  approval: Approval
  /** How many Approvals are waiting on this Person in the Thread, this one included. */
  waiting: number
  /** Nothing can be decided just now (`Allowed`). */
  held: boolean
  onDecide: (decision: ApprovalDecision) => void
}) {
  const panel = useId()
  const [open, setOpen] = useState(true)
  const [pressed, setPressed] = useState<Option.Option<string>>(Option.none())
  // Closed, the rows are out of sight and must not be pressed, by a pointer or a number key.
  const reach: Reach = held || !open ? 'held' : 'pressable'
  const answers = answersOf(approval)
  const pick = (label: string) => {
    const answer = answers.find((each) => each.option.label === label)
    if (answer === undefined) return
    setPressed(Option.some(label))
    onDecide(answer.decision)
  }
  return (
    <section aria-label="Vivid asks first" className={SURFACE} onKeyDown={steer}>
      <Head
        words={approval.action.summary}
        count={
          waiting > 1
            ? Option.some({ shown: `1/${waiting}`, said: `The first of ${waiting} waiting on you` })
            : Option.none()
        }
        open={open}
        panel={panel}
        onToggle={() => setOpen((shown) => !shown)}
      />
      <Panel id={panel} open={open}>
        <ul className="mt-2 flex min-w-0 flex-col gap-0.5 ps-8 pe-1 pb-1 sm:ps-7">
          {answers.map(({ option }, place) => (
            <Row
              key={option.label}
              option={option}
              digit={Option.some(place + 1)}
              several={false}
              reach={reach}
              standing={asking.standingOf(held && Option.contains(pressed, option.label), held)}
              onPress={() => pick(option.label)}
            />
          ))}
        </ul>
      </Panel>
      {/* There only while the rows can be pressed: see `digits`. */}
      {reach === 'pressable' && (
        <span
          hidden
          ref={digits(
            answers.map((answer) => answer.option),
            pick,
          )}
        />
      )}
    </section>
  )
}
