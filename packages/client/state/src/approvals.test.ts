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
import { approvalUp } from './approvals.js'

const me = { id: PersonId.make('me'), name: 'Ada', image: null }
const them = { id: PersonId.make('them'), name: 'Bisi', image: null }
const pending = ApprovalState.cases.Pending.make({ expiresAt: 2_000 })
const denied = ApprovalState.cases.Denied.make({ decidedBy: me, decidedAt: 1_500 })

/** One Approval, named and addressed; everything else about it is the same. */
const approval = (
  id: string,
  askedOf: Approval['askedOf'],
  state: Approval['state'],
): Approval => ({
  id: ApprovalId.make(id),
  threadId: ThreadId.make('thread'),
  runId: null,
  action: {
    summary: 'Send the signed NDA to Dami',
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
  askedOf,
  state,
  createdAt: 1_000,
})

describe('the Approval that is up over the composer', () => {
  it('is the oldest one still waiting on this Person, counted with the others waiting on them', () => {
    const up = approvalUp(
      [
        approval('settled', me, denied),
        approval('theirs', them, pending),
        approval('first', me, pending),
        approval('second', me, pending),
      ],
      me.id,
    )
    expect(Option.map(up, (found) => [found.approval.id, found.waiting])).toEqual(
      Option.some([ApprovalId.make('first'), 2]),
    )
  })

  it('is none when nothing is waiting on this Person', () => {
    expect(
      approvalUp([approval('settled', me, denied), approval('theirs', them, pending)], me.id),
    ).toEqual(Option.none())
  })
})
