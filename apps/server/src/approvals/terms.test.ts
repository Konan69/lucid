import * as NodeBuffer from 'node:buffer'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import { Context, Effect, Layer, Ref, Schema } from 'effect'
import {
  ActionTarget,
  Approval,
  ApprovalChanged,
  ApprovalDecision,
  ApprovalState,
  BrowserAction,
  BrowseResult,
  BrowseTarget,
  ProposedAction,
} from '@vivid/contracts'
import { scopedCase } from '../../tests/case.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { connections } from '../connections/tables.ts'
import { decodeRow } from '../connections/records.ts'
import { Executor, ExecutorCallOutcome } from '../connections/executor.ts'
import { gmailServiceId } from '../connections/google.ts'
import { inspectMail } from '../connections/mail.ts'
import { ComputerStore, inspectBrowser } from '../computers/store.ts'
import { BrowseAuthority, DeviceRegistry } from '../computers/device.ts'
import { ActionRunner, Gate, GateDecision, gateLayer } from './gate.ts'
import { ApprovalStore, approvalStoreLayer } from './store.ts'
import { fixture, Observation, trustTestServices } from './testing.ts'

/** Raw MIME is the provider's actual envelope, including the bytes of the attachment. */
const mime = (to: string) =>
  NodeBuffer.Buffer.from(
    `To: ${to}\r\nCc: ada@example.test\r\nSubject: Booking\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nBook this\r\n--x\r\nContent-Disposition: attachment; filename=quote.txt\r\n\r\nPrice 20 USD\r\n--x--`,
  ).toString('base64url')
const page = (price: number) =>
  BrowseResult.make({
    address: 'https://shop.example.test/checkout',
    title: 'Checkout',
    outline: `Total ${price} USD. One room available. Nonrefundable. Pay now.`,
    truncated: false,
    tabs: [],
  })
const thread = (ids: readonly string[]): Schema.Json => ({
  messages: ids.map((id) => ({ id, payload: { body: { data: `Reply ${id}` } } })),
})

interface SourceService {
  readonly raw: Ref.Ref<string>
  readonly replies: Ref.Ref<Schema.Json>
  readonly page: Ref.Ref<BrowseResult>
  readonly reads: Ref.Ref<ReadonlyArray<string>>
}
class Source extends Context.Service<Source, SourceService>()('ApprovalTermsTestSource') {}

/** Only external authorities are fake. Gate policy, binding persistence, claim, invalidation,
 * journal and delivery are the real implementations over disposable PostgreSQL. */
const external = Layer.effectContext(
  Effect.gen(function* () {
    const source = Source.of({
      raw: yield* Ref.make(mime('dami@example.test')),
      replies: yield* Ref.make(thread(['message-1'])),
      page: yield* Ref.make(page(20)),
      reads: yield* Ref.make<ReadonlyArray<string>>([]),
    })
    const ports = yield* Layer.build(
      Layer.mergeAll(
        Layer.mock(Executor, {
          call: Effect.fn('TermsTest.executor')(function* ({ tool, input }) {
            yield* Ref.update(source.reads, (reads) => [...reads, tool])
            if (tool === 'gmailApi.gmailUsersDraftsGet') {
              expect(input).toEqual({
                path: { userId: 'me', id: 'draft-1' },
                query: { format: 'raw' },
              })
              return ExecutorCallOutcome.cases.Completed.make({
                value: { message: { raw: yield* Ref.get(source.raw), threadId: 'thread-1' } },
              })
            }
            expect(tool).toBe('gmailApi.gmailUsersThreadsGet')
            expect(input).toEqual({
              path: { userId: 'me', id: 'thread-1' },
              query: { format: 'full' },
            })
            return ExecutorCallOutcome.cases.Completed.make({
              value: yield* Ref.get(source.replies),
            })
          }),
        }),
        Layer.mock(ComputerStore, {
          browse: (_person, action) => {
            expect(action).toEqual(BrowserAction.cases.Read.make({}))
            return Ref.get(source.page)
          },
        }),
        Layer.mock(DeviceRegistry, {}),
      ),
    )
    return Context.add(ports, Source, source)
  }),
)

/** Rebuild the stores over the controlled external ports. The observation runner still records
 * any execution, while inspection exercises the production Gmail and browser adapters. */
const controlled = Layer.effectContext(
  Effect.gen(function* () {
    const base = yield* Layer.build(trustTestServices)
    const ports = yield* Layer.build(external)
    const database = yield* Database
    const runner = Context.get(base, ActionRunner)
    return Context.merge(base, ports).pipe(
      Context.add(
        ActionRunner,
        ActionRunner.of({
          ...runner,
          inspect: Effect.fn('TermsTest.inspect')(function* (input) {
            const target = input.action.target
            if (ActionTarget.guards.Browser(target))
              return yield* inspectBrowser({
                person: input.person,
                origin: input.origin,
                target,
                authority:
                  input.phase === 'Deciding'
                    ? BrowseAuthority.cases.Approved.make({})
                    : BrowseAuthority.cases.Acting.make({}),
              }).pipe(Effect.provide(ports))
            if (!ActionTarget.guards.Connection(target)) return []
            const [value] = yield* database.run(
              database.select().from(connections).where(eq(connections.id, target.connectionId)),
            )
            if (value === undefined) return yield* Effect.die('Fixture Integration missing')
            return yield* inspectMail(yield* decodeRow(value), target).pipe(Effect.provide(ports))
          }),
        }),
      ),
    )
  }),
)
const services = gateLayer.pipe(
  Layer.provideMerge(approvalStoreLayer.pipe(Layer.provideMerge(controlled))),
)

/** Ask through the real Gate so capture happens at the same boundary as a tool call. */
const ask = Effect.fn('TermsTest.ask')(function* (
  test: Effect.Success<ReturnType<typeof fixture>>,
  action: ProposedAction,
) {
  const decision = yield* (yield* Gate).check(test.vivid, action, 'Ordinary', test.bound)
  if (!GateDecision.guards.ApprovalRequired(decision))
    return yield* Effect.die('Expected a fresh ask')
  return decision.approval
})

/** The stale decision cannot execute. Its delivery explicitly tells Vivid to prepare a fresh
 * ask, and preparing again must produce a new id and digest rather than revive the old ask. */
const reasks = Effect.fn('TermsTest.reasks')(function* (
  test: Effect.Success<ReturnType<typeof fixture>>,
  approval: Approval,
) {
  const store = yield* ApprovalStore
  expect(
    yield* Effect.flip(
      store.decide(test.personal, {
        id: approval.id,
        digest: approval.digest,
        decision: ApprovalDecision.cases.AllowOnce.make({}),
      }),
    ),
  ).toEqual(new ApprovalChanged({ id: approval.id }))
  const history = yield* store.inThread(test.personalId)
  const stale = history.find((item) => item.id === approval.id)
  if (stale === undefined || !ApprovalState.guards.Invalidated(stale.state))
    return yield* Effect.die('The old Approval must be invalidated')
  expect(stale.state.reason._tag).toBe('ExternalStateChanged')
  const observed = yield* Observation
  expect(yield* Ref.get(observed.actions)).toEqual([])
  expect(JSON.stringify(yield* Ref.get(observed.deliveries))).toContain('asks the person afresh')
  const fresh = yield* ask(test, approval.action)
  expect(fresh.id).not.toBe(approval.id)
  expect(fresh.digest).not.toBe(approval.digest)
  expect(ApprovalState.guards.Pending(fresh.state)).toBe(true)
  const settled = yield* store.decide(test.personal, {
    id: fresh.id,
    digest: fresh.digest,
    decision: ApprovalDecision.cases.AllowOnce.make({}),
  })
  expect(ApprovalState.guards.Succeeded(settled.state)).toBe(true)
  expect(yield* Ref.get(observed.actions)).toEqual([fresh.action])
})

/** The stored Integration identity, rather than a mail-looking tool name, opts into enforcement. */
const mailAction = Effect.fn('TermsTest.mail')(function* (
  test: Effect.Success<ReturnType<typeof fixture>>,
) {
  const database = yield* Database
  yield* database.run(
    database
      .update(connections)
      .set({ service: gmailServiceId })
      .where(eq(connections.id, test.connectionId)),
  )
  return ProposedAction.make({
    ...test.connectionAction,
    effect: 'destructive',
    summary: 'Send the booking reply to Dami',
    target: ActionTarget.cases.Connection.make({
      connectionId: test.connectionId,
      account: 'Work Gmail',
      tool: 'gmailApi.gmailUsersDraftsSend',
      input: { path: { userId: 'me' }, body: { id: 'draft-1' } },
    }),
  })
})

layer(testDatabaseLayer, { excludeTestServices: true })((it) => {
  describe.skipIf(!testDatabaseConfigured)('External approval terms', () => {
    it.effect('a changed checkout price invalidates the browser approval and re-asks', () =>
      scopedCase(
        services,
        Effect.gen(function* () {
          const test = yield* fixture()
          const action = ProposedAction.make({
            summary: 'Pay for the room',
            rationale: 'Book the requested stay',
            effect: 'destructive',
            target: ActionTarget.cases.Browser.make({
              target: BrowseTarget.cases.Vivid.make({}),
              action: BrowserAction.cases.Click.make({ target: 'Pay now' }),
            }),
          })
          // A pre-deployment pending ask has no page baseline and must not grandfather a click.
          const store = yield* ApprovalStore
          const legacy = yield* store.raise(test.vivid, action, test.bound)
          expect(
            yield* Effect.flip(
              store.decide(test.personal, {
                id: legacy.id,
                digest: legacy.digest,
                decision: ApprovalDecision.cases.AllowOnce.make({}),
              }),
            ),
          ).toEqual(new ApprovalChanged({ id: legacy.id }))
          const approval = yield* ask(test, action)
          yield* Ref.set((yield* Source).page, page(35))
          yield* reasks(test, approval)
        }),
        'fresh',
      ),
    )

    it.effect('added Gmail recipients invalidate the draft approval and re-ask', () =>
      scopedCase(
        services,
        Effect.gen(function* () {
          const test = yield* fixture()
          const approval = yield* ask(test, yield* mailAction(test))
          yield* Ref.set((yield* Source).raw, mime('dami@example.test, outsider@example.test'))
          yield* reasks(test, approval)
          expect((yield* Ref.get((yield* Source).reads)).join(',')).toBe(
            'gmailApi.gmailUsersDraftsGet,gmailApi.gmailUsersThreadsGet,'.repeat(4).slice(0, -1),
          )
        }),
        'fresh',
      ),
    )

    it.effect('a new incoming Gmail reply invalidates the send approval and re-asks', () =>
      scopedCase(
        services,
        Effect.gen(function* () {
          const test = yield* fixture()
          const action = yield* mailAction(test)
          const direct = ProposedAction.make({
            ...action,
            target: ActionTarget.cases.Connection.make({
              connectionId: test.connectionId,
              account: 'Work Gmail',
              tool: 'gmailApi.gmailUsersMessagesSend',
              input: {
                path: { userId: 'me' },
                body: { raw: mime('dami@example.test'), threadId: 'thread-1' },
              },
            }),
          })
          const approval = yield* ask(test, direct)
          yield* Ref.set((yield* Source).replies, thread(['message-1', 'message-2']))
          yield* reasks(test, approval)
          expect(yield* Ref.get((yield* Source).reads)).toEqual(
            Array(4).fill('gmailApi.gmailUsersThreadsGet'),
          )
        }),
        'fresh',
      ),
    )
  })
})
