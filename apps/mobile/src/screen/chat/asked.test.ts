import {
  ActionTarget,
  ApprovalId,
  ApprovalState,
  ConnectionId,
  PersonId,
  ThreadId,
  type Approval,
} from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  ApprovalHold,
  approvalHoldOf,
  Deciding,
  isDeciding,
  KEYBOARD_RESERVE,
  keyboardRoomOf,
  refusedAfter,
  tallestOf,
  wasRefused,
} from './asked'

/** One pending Approval by name; everything else about it is the same. */
const approval = (id: string, summary: string): Approval => ({
  id: ApprovalId.make(id),
  threadId: ThreadId.make('thread'),
  runId: null,
  action: {
    summary,
    rationale: '',
    effect: 'destructive',
    target: ActionTarget.cases.Connection.make({
      connectionId: ConnectionId.make('connection'),
      account: 'Gmail (Work)',
      tool: 'send',
      input: {},
    }),
  },
  digest: 'digest',
  askedOf: { id: PersonId.make('me'), name: 'Ada', image: null },
  state: ApprovalState.cases.Pending.make({ expiresAt: 2_000 }),
  createdAt: 1_000,
})

describe('what the Approval banner holds', () => {
  const first = { approval: approval('first', 'Send the NDA'), waiting: 2 }
  const second = { approval: approval('second', 'Delete the draft'), waiting: 1 }

  it('holds nothing until it has taken one', () => {
    expect(approvalHoldOf(Option.none(), Option.some(first))).toEqual(ApprovalHold.Free())
  })

  it('draws the one that is up from its newest record', () => {
    const newer = { approval: approval('first', 'Send the signed NDA'), waiting: 5 }
    expect(approvalHoldOf(Option.some(first), Option.some(newer))).toEqual(
      ApprovalHold.Up({ up: newer }),
    )
  })

  it('keeps what it held while it slides away, though another is up', () => {
    expect(approvalHoldOf(Option.some(first), Option.some(second))).toEqual(
      ApprovalHold.Leaving({ up: first }),
    )
    expect(approvalHoldOf(Option.some(first), Option.none())).toEqual(
      ApprovalHold.Leaving({ up: first }),
    )
  })
})

describe('one try at deciding an Approval', () => {
  const first = ApprovalId.make('first')
  const second = ApprovalId.make('second')

  it('is refused when the try that failed is the one on its way', () => {
    const after = refusedAfter(Deciding.Flying({ attempt: 1, id: first }), 1)
    expect(wasRefused(after, first)).toBe(true)
    expect(isDeciding(after, first)).toBe(false)
  })

  it('leaves a later try alone when an older one fails late', () => {
    const later = Deciding.Flying({ attempt: 2, id: second })
    const after = refusedAfter(later, 1)
    expect(after).toEqual(later)
    expect(isDeciding(after, second)).toBe(true)
    expect(wasRefused(after, first)).toBe(false)
  })

  it('says a refusal only about the Approval it was for', () => {
    const refused = Deciding.Refused({ id: first })
    expect(wasRefused(refused, second)).toBe(false)
    expect(isDeciding(refused, first)).toBe(false)
  })
})

describe('tallestOf', () => {
  const phone = { window: 844, keyboard: KEYBOARD_RESERVE, bar: 147, composer: 60 }

  it('is what is left between the bar and the composer over the keyboard', () => {
    expect(tallestOf(phone)).toBe(844 - 336 - 147 - 60 - 12)
  })

  it('gives the room of the keyboard back while the keyboard is down', () => {
    const down = tallestOf({ ...phone, keyboard: keyboardRoomOf(false) })
    const up = tallestOf({ ...phone, keyboard: keyboardRoomOf(true) })
    expect(down).toBe(Math.min(560, 844 - 147 - 60 - 12))
    expect(down - up).toBeGreaterThan(200)
  })

  it('is never more than its ceiling on a large screen', () => {
    expect(tallestOf({ ...phone, window: 1366 })).toBe(560)
  })

  it('is never squeezed under its floor on a small one', () => {
    expect(tallestOf({ ...phone, window: 568 })).toBe(160)
  })

  it('counts a negative measure as none', () => {
    expect(tallestOf({ ...phone, keyboard: -40, window: 700 })).toBe(700 - 147 - 60 - 12)
  })
})
