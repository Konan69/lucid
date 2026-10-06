import { describe, expect, it } from '@effect/vitest'
import { ActionTarget, ApprovalDecision, ApprovalState } from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import {
  chainFixture,
  chainLayer,
  completeRun,
  toolParts,
  waitForState,
  type ChainFixture,
} from '../runtime/chains.ts'
import { proofAccounts } from './proof.ts'

const UsedAccount = Schema.Struct({ account: Schema.String })
const decodeUsed = Schema.decodeUnknownOption(UsedAccount)

/**
 * Asks Vivid to save one record through the account the Person names, and lets it happen: when
 * the Gate asks the Person first, the Approval is allowed here. It answers with the accounts
 * Vivid named in its calls, and with the account the Approval was raised for when there was one.
 * Whether a write is asked about is the Gate's decision and not this proof's claim, so both
 * paths are followed; which account saved the record is read from the service afterwards.
 */
const saveThrough = Effect.fn('NamedAccountProof.saveThrough')(function* (
  fixture: ChainFixture,
  ask: string,
  /** How many calls the Thread already held before this ask; they are not this ask's. */
  earlier: number,
) {
  const runId = yield* fixture.send(ask)
  const settled = yield* completeRun(fixture, runId)
  const named = toolParts(settled)
    .flatMap((part) =>
      part.toolName === 'use_tool'
        ? Option.toArray(decodeUsed(part.input)).map((used) => used.account)
        : [],
    )
    .slice(earlier)
  expect(named.length, 'The real model must call the tool itself').toBeGreaterThan(0)
  const detail = yield* fixture.rpc.GetThread({ id: fixture.threadId })
  const approval = detail.approvals.find((item) => ApprovalState.guards.Pending(item.state))
  if (approval === undefined) return { named, asked: Option.none<string>() }
  const target = approval.action.target
  if (!ActionTarget.guards.Connection(target))
    return yield* Effect.sync(() => expect.fail('The Approval must be for an Integration'))
  const decided = yield* fixture.rpc.DecideApproval({
    id: approval.id,
    digest: approval.digest,
    decision: ApprovalDecision.cases.AllowOnce.make({}),
  })
  expect(ApprovalState.guards.Succeeded(decided.approval.state)).toBe(true)
  // The outcome is delivered into the Thread; wait for that Run so the next ask starts clean.
  yield* waitForState(
    fixture.conversation,
    (state) => state.settlements.length > settled.settlements.length,
  )
  return { named, asked: Option.some(target.account) }
})

/**
 * Behavioural claim: with two accounts on one Integration, Vivid acts through the account the
 * Person names, whether they name it by their own word for it or by who the service says it is.
 *
 * Real server, runtime, model and Executor. The two accounts are two real Executor accounts on
 * one app; each record says which account saved it, so the evidence is the service's own storage
 * and not what Vivid reported. One model attempt per ask, no judge, no retry.
 */
describe.skipIf(process.env['VIVID_LIVE_NAMED_ACCOUNT'] !== '1')('named account live chain', () => {
  it.live(
    'saves through the work account when asked, and through the other one when asked for it',
    () =>
      Effect.gen(function* () {
        const fixture = yield* chainFixture('Named account proof')
        const accounts = yield* proofAccounts(fixture, ['ada@work.example', 'ada@home.example'])
        // Executor said who each account is; the Person calls the first one "Work".
        expect([accounts.first.identity, accounts.second.identity]).toEqual([
          'ada@work.example',
          'ada@home.example',
        ])
        const renamed = yield* fixture.rpc.RenameConnection({
          id: accounts.first.id,
          name: 'Work',
        })
        expect(renamed.connection.account).toBe('Proof Accounts (Work)')
        const listed = yield* fixture.rpc.ListConnections()
        expect(listed.connections.map((item) => item.account).toSorted()).toEqual([
          'Proof Accounts (Work)',
          'Proof Accounts (ada@home.example)',
        ])
        expect(yield* accounts.records('work account verified')).toEqual([])

        const work = yield* saveThrough(
          fixture,
          'In Proof Accounts, save a record whose subject is "work account verified", using my work account. Discover the tool, then call use_tool directly. Do not use a program. Ask me for approval if needed.',
          0,
        )
        // Vivid named the work account and no other, and where the Person was asked first,
        // they were asked about that account by its own name.
        expect(new Set(work.named)).toEqual(new Set(['Proof Accounts (Work)']))
        expect(Option.getOrElse(work.asked, () => 'Proof Accounts (Work)')).toBe(
          'Proof Accounts (Work)',
        )
        expect(yield* accounts.records('work account verified')).toEqual([
          { subject: 'work account verified', by: 'ada@work.example' },
        ])

        const home = yield* saveThrough(
          fixture,
          'Now save another record whose subject is "home account verified", but through the ada@home.example account this time. Call use_tool directly. Ask me for approval if needed.',
          work.named.length,
        )
        expect(new Set(home.named)).toEqual(new Set(['Proof Accounts (ada@home.example)']))
        expect(Option.getOrElse(home.asked, () => 'Proof Accounts (ada@home.example)')).toBe(
          'Proof Accounts (ada@home.example)',
        )
        expect(yield* accounts.records('home account verified')).toEqual([
          { subject: 'home account verified', by: 'ada@home.example' },
        ])
        // The first record is still the only one of its subject: nothing was replayed.
        expect(yield* accounts.records('work account verified')).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(chainLayer)),
    { timeout: 180_000 },
  )
})
