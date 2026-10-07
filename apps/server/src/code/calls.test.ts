import { deviceLayer } from '../computers/device.ts'
import { describe, expect, it as standalone, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import {
  ApprovalDecision,
  CodeOutcome,
  RuleScope,
  DatabaseUnavailable,
  ServiceUnavailable,
  CodeCallKind,
  BrowseTarget,
  BrowserAction,
  type ThreadId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Deferred, Effect, Fiber, Layer, Logger, Ref, Result, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { refusalLogs } from '../observability/testlogger.ts'
import type { Actor } from '../auth/access.ts'
import { membershipTable } from '../companies/tables.ts'
import { threads } from '../threads/tables.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { absentMachineLayer } from '../computers/testing.ts'
import {
  ComputerAccess,
  ComputerNotReady,
  ComputerStore,
  computerMachineKey,
  computerStoreLayer,
} from '../computers/store.ts'
import { Executor, ExecutorCallOutcome } from '../connections/executor.ts'
import { ConnectionStore } from '../connections/store.ts'
import { ConnectionProbe, connectionTestLayer, serviceId } from '../connections/testing.ts'
import { ApprovalStore } from '../approvals/store.ts'
import { fixture, Observation, trustTestLayer } from '../approvals/testing.ts'
import { RuleStore } from '../rules/store.ts'
import { CodeAuthority, CodeAuthorityRevoked, codeAuthorityLayer } from './authority.ts'
import { CodeCalls, codeCallsLayer } from './calls.ts'
import { codeHandlers } from './handlers.ts'
import { publicPageLayer } from './page.ts'
import { CallOutcome, codeProcessLayer } from './process.ts'
import { WorkerMessage } from './protocol.ts'
import { localCodeComputerLayer } from './testing.ts'

const isRepositoryInput = Schema.is(Schema.Struct({ repoName: Schema.String }))

const accounts = Layer.mergeAll(connectionTestLayer, trustTestLayer, absentMachineLayer)
const computers = computerStoreLayer.pipe(
  Layer.provideMerge(deviceLayer),
  Layer.provideMerge(accounts),
)
const dependencies = Layer.mergeAll(codeAuthorityLayer, publicPageLayer).pipe(
  Layer.provideMerge(computers),
)
const testLayer = codeCallsLayer.pipe(Layer.provideMerge(dependencies))
const use = (tool: string) =>
  `tools.use_tool({account:"Records",tool:${JSON.stringify(tool)},input:{draft:"original"},summary:"Read or update records",rationale:"Answer the request"})`

/** Invoke the public RPC handler with injected private authority, through real stores, Gate and interpreter. */
const run = Effect.fn('Test.RunCode')((actor: Actor, thread: ThreadId, code: string) =>
  codeHandlers
    .RunCode({ code, summary: 'Work with records' })
    .pipe(
      Effect.provideService(
        AuthContext,
        AuthState.Vivid({ person: actor.person, workspace: actor.workspace, threadId: thread }),
      ),
    ),
)

/** Connection credentials are replaced at their external adapter; all tenancy, Gate and Approval SQL is real. */
describe.skipIf(!testDatabaseConfigured)(
  'Programs under live authority',
  { timeout: 30_000 },
  () => {
    // The program runs on a Computer that is this machine (`testing.ts`); each test still owns
    // fresh tenancy, Gate and provider fixtures, and each program its own process. The ceiling is
    // for those real processes on a loaded machine; nothing here waits on a clock.
    layer(codeProcessLayer.pipe(Layer.provide(localCodeComputerLayer)))((it) => {
      it.effect(
        'composes real named Connection calls and a gated Computer command with only selected results returned',
        () =>
          Effect.gen(function* () {
            const caseContext = yield* Layer.build(testLayer)
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const test = yield* fixture()
                yield* (yield* ConnectionStore).begin(test.personal, {
                  service: serviceId,
                  name: null,
                  shared: false,
                })
                const executor = yield* Executor
                const inputs = yield* Ref.make<readonly import('effect/Schema').Json[]>([])
                const provider = Executor.of({
                  ...executor,
                  call: Effect.fn('Test.records')(function* ({ input }) {
                    yield* Ref.update(inputs, (values) => values.concat([input]))
                    return ExecutorCallOutcome.cases.Completed.make({
                      value: {
                        cursor: 'next-page',
                        rows: Array.from({ length: 500 }, (_, value) => ({ value })),
                      },
                    })
                  }),
                })
                const storedComputer = yield* ComputerStore
                const computer = ComputerStore.of({
                  ...storedComputer,
                  access: Effect.fn('Test.computerAccess')((person) =>
                    Effect.succeed(
                      ComputerAccess.cases.Ready.make({ key: computerMachineKey(person) }),
                    ),
                  ),
                })
                const outcome = yield* Effect.gen(function* () {
                  const caseContext = yield* Layer.build(Layer.fresh(codeCallsLayer))
                  return yield* run(
                    test.personal,
                    test.personalId,
                    `const found=await tools.find_tools({query:"read"}); const tool=found.tools[0];
      const first=await tools.use_tool({account:tool.account,tool:tool.tool,input:{},summary:"Read first page",rationale:"Find records"});
      const [left,right]=await Promise.all([1,2].map(page=>tools.use_tool({account:tool.account,tool:tool.tool,input:{cursor:first.output.cursor,page},summary:"Read next page",rationale:"Find records"})));
      return {chosen:left.output.rows.filter(row=>row.value>497).map(row=>row.value),count:right.output.rows.length};`,
                  ).pipe(Effect.provide(caseContext))
                }).pipe(
                  Effect.scoped,
                  Effect.provideService(Executor, provider),
                  Effect.provideService(ComputerStore, computer),
                )
                expect(CodeOutcome.guards.Completed(outcome)).toBe(true)
                expect(outcome).toHaveProperty('result', {
                  chosen: [498, 499],
                  count: 500,
                })
                expect(outcome.calls.map((call) => call.kind)).toEqual([
                  'find_tools',
                  'use_tool',
                  'use_tool',
                  'use_tool',
                ])
                expect(yield* Ref.get(inputs)).toEqual([
                  {},
                  { cursor: 'next-page', page: 1 },
                  { cursor: 'next-page', page: 2 },
                ])
              }),
            ).pipe(Effect.provide(caseContext))
          }).pipe(Effect.scoped),
      )

      it.effect(
        'returns validation problems to a program and accepts its corrected next call',
        () =>
          Effect.gen(function* () {
            const caseContext = yield* Layer.build(testLayer)
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const test = yield* fixture()
                yield* (yield* ConnectionStore).begin(test.personal, {
                  service: serviceId,
                  name: null,
                  shared: false,
                })
                const executor = yield* Executor
                const provider = Executor.of({
                  ...executor,
                  call: Effect.fn('Test.validation')(({ input }) =>
                    Effect.succeed(
                      isRepositoryInput(input)
                        ? ExecutorCallOutcome.cases.Completed.make({ value: { corrected: true } })
                        : ExecutorCallOutcome.cases.Rejected.make({
                            message: 'Correct the input',
                            problems: ['repoName: required'],
                          }),
                    ),
                  ),
                })
                const outcome = yield* Effect.gen(function* () {
                  const caseContext = yield* Layer.build(Layer.fresh(codeCallsLayer))
                  return yield* run(
                    test.personal,
                    test.personalId,
                    `const first=await ${use('read')}; const next=await tools.use_tool({account:"Records",tool:"read",input:{repoName:"facebook/react"},summary:"Read",rationale:"Answer"}); return {first,next};`,
                  ).pipe(Effect.provide(caseContext))
                }).pipe(Effect.scoped, Effect.provideService(Executor, provider))
                expect(outcome).toHaveProperty('result', {
                  first: {
                    ok: false,
                    reason: 'Correct the input',
                    problems: ['repoName: required'],
                  },
                  next: { ok: true, output: { corrected: true } },
                })
                expect(outcome.calls.map((call) => call.end)).toEqual(['refused', 'completed'])
              }),
            ).pipe(Effect.provide(caseContext))
          }).pipe(Effect.scoped),
      )

      it.effect(
        'keeps colliding personal account names scoped and rejects forged ownership fields',
        () =>
          Effect.gen(function* () {
            const caseContext = yield* Layer.build(testLayer)
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const test = yield* fixture()
                const store = yield* ConnectionStore
                yield* store.begin(test.personal, {
                  service: serviceId,
                  name: 'Records',
                  shared: false,
                })
                yield* store.begin(test.other, {
                  service: serviceId,
                  name: 'Records',
                  shared: false,
                })
                const probe = yield* ConnectionProbe
                yield* Ref.set(probe.calls, 0)
                yield* Ref.set(
                  probe.outcome,
                  ExecutorCallOutcome.cases.Completed.make({
                    value: { record: 'provider-record-id' },
                  }),
                )
                const result = yield* run(
                  test.personal,
                  test.personalId,
                  `const found=await tools.find_tools({query:"read"}); const result=await tools.use_tool({account:"Records (Records)",tool:"read",input:{draft:"original"},summary:"Read or update records",rationale:"Answer the request"});
            const forged=await tools.use_tool({account:"Records (Records)",tool:"read",connectionId:"other-person",input:{},summary:"Read",rationale:"Read"}); return {found,result,forged};`,
                )
                expect(CodeOutcome.guards.Completed(result)).toBe(true)
                expect(JSON.stringify(result)).not.toContain('connectionId')
                expect(JSON.stringify(result)).not.toContain(test.other.person.id)
                expect(result.calls.map((call) => call.end)).toEqual([
                  'completed',
                  'completed',
                  'refused',
                ])
                expect(yield* Ref.get(probe.calls)).toBe(1)
              }),
            ).pipe(Effect.provide(caseContext))
          }).pipe(Effect.scoped),
      )

      for (const revocation of ['Membership', 'Thread visibility'] as const)
        it.effect(
          `refreshes ${revocation} after the dispatch barrier and refuses the next queued call`,
          () =>
            Effect.gen(function* () {
              const caseContext = yield* Layer.build(testLayer)
              return yield* Effect.scoped(
                Effect.gen(function* () {
                  const test = yield* fixture()
                  yield* (yield* ConnectionStore).begin(test.owner, {
                    service: serviceId,
                    name: null,
                    shared: true,
                  })
                  const started = yield* Deferred.make<void>()
                  const release = yield* Deferred.make<void>()
                  const executor = yield* Executor
                  const controlled = Executor.of({
                    ...executor,
                    call: Effect.fn('Test.revocationCall')(function* () {
                      yield* Deferred.succeed(started, undefined)
                      yield* Deferred.await(release)
                      return ExecutorCallOutcome.cases.Completed.make({ value: { read: true } })
                    }),
                  })
                  const program = Effect.gen(function* () {
                    const caseContext = yield* Layer.build(Layer.fresh(codeCallsLayer))
                    return yield* run(
                      test.member,
                      test.companyId,
                      `await ${use('read')}; return await ${use('read')};`,
                    ).pipe(Effect.provide(caseContext))
                  }).pipe(Effect.scoped, Effect.provideService(Executor, controlled))
                  const running = yield* Effect.forkChild(program)
                  yield* Deferred.await(started)
                  const database = yield* Database
                  if (revocation === 'Membership')
                    yield* database.run(
                      database
                        .delete(membershipTable)
                        .where(eq(membershipTable.userId, test.member.person.id)),
                    )
                  else
                    yield* database.run(
                      database
                        .update(threads)
                        .set({ personId: test.owner.person.id })
                        .where(eq(threads.id, test.companyId)),
                    )
                  yield* Deferred.succeed(release, undefined)
                  const outcome = yield* Fiber.join(running)
                  expect(CodeOutcome.guards.Blocked(outcome)).toBe(true)
                  expect(outcome.calls.map((call) => call.end)).toEqual(['completed', 'refused'])
                }),
              ).pipe(Effect.provide(caseContext))
            }).pipe(Effect.scoped),
        )

      it.effect('refuses shared Connection writes', () =>
        Effect.gen(function* () {
          const caseContext = yield* Layer.build(testLayer)
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const test = yield* fixture()
              const store = yield* ConnectionStore
              yield* store.begin(test.owner, { service: serviceId, name: null, shared: true })
              const shared = yield* run(
                test.member,
                test.companyId,
                `return await ${use('write')};`,
              )
              expect(shared.calls.map((call) => call.end)).toEqual(['refused'])
            }),
          ).pipe(Effect.provide(caseContext))
        }).pipe(Effect.scoped),
      )

      it.effect('asks before personal reads enter a shared Thread', () =>
        Effect.gen(function* () {
          const caseContext = yield* Layer.build(testLayer)
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const test = yield* fixture()
              const store = yield* ConnectionStore
              yield* store.begin(test.personal, {
                service: serviceId,
                name: 'Private records',
                shared: false,
              })
              yield* (yield* Database).run(
                (yield* Database)
                  .update(threads)
                  .set({ audience: 'company' })
                  .where(eq(threads.id, test.companyId)),
              )
              const personal = yield* run(
                test.member,
                test.companyId,
                `return await tools.use_tool({account:"Records (Private records)",tool:"read",input:{},summary:"Read private records",rationale:"Answer"});`,
              )
              expect(CodeOutcome.guards.ApprovalRequired(personal)).toBe(true)
              expect(personal.calls.map((call) => call.end)).toEqual(['needs approval'])
            }),
          ).pipe(Effect.provide(caseContext))
        }).pipe(Effect.scoped),
      )

      it.effect(
        'stores the exact first action, closes queued effects, and two Approval answers execute once',
        () =>
          Effect.gen(function* () {
            const caseContext = yield* Layer.build(testLayer)
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const test = yield* fixture()
                yield* (yield* ConnectionStore).begin(test.personal, {
                  service: serviceId,
                  name: null,
                  shared: false,
                })
                const probe = yield* ConnectionProbe
                yield* Ref.set(probe.calls, 0)
                const outcome = yield* run(
                  test.personal,
                  test.personalId,
                  `try {await Promise.allSettled([${use('write')},${use('write')}]);} finally {await ${use('write')};}`,
                )
                expect(CodeOutcome.guards.ApprovalRequired(outcome)).toBe(true)
                expect(yield* Ref.get(probe.calls)).toBe(0)
                const store = yield* ApprovalStore
                const approvals = yield* store.inThread(test.personalId)
                expect(approvals).toHaveLength(1)
                const approval = approvals[0]
                if (approval === undefined) return yield* Effect.die('No approval')
                const request = {
                  id: approval.id,
                  digest: approval.digest,
                  decision: ApprovalDecision.cases.AllowOnce.make({}),
                }
                const decisions = yield* Effect.all(
                  [
                    Effect.result(store.decide(test.personal, request)),
                    Effect.result(store.decide(test.personal, request)),
                  ],
                  { concurrency: 2 },
                )
                expect(decisions.filter(Result.isSuccess)).toHaveLength(1)
                const actions = yield* Ref.get((yield* Observation).actions)
                expect(actions).toEqual([approval.action])
                expect(approval.action.target).toMatchObject({ input: { draft: 'original' } })
                return yield* Effect.void
              }),
            ).pipe(Effect.provide(caseContext))
          }).pipe(Effect.scoped),
      )

      it.effect(
        'retains an earlier Connection receipt when the next action asks for Approval',
        () =>
          Effect.gen(function* () {
            const caseContext = yield* Layer.build(testLayer)
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const test = yield* fixture()
                yield* (yield* ConnectionStore).begin(test.personal, {
                  service: serviceId,
                  name: null,
                  shared: false,
                })
                const probe = yield* ConnectionProbe
                yield* Ref.set(probe.calls, 0)
                const outcome = yield* run(
                  test.personal,
                  test.personalId,
                  `await ${use('read')}; return await ${use('write')};`,
                )
                expect(CodeOutcome.guards.ApprovalRequired(outcome)).toBe(true)
                expect(outcome.calls.map((call) => call.end)).toEqual([
                  'completed',
                  'needs approval',
                ])
                expect(yield* Ref.get(probe.calls)).toBe(1)
              }),
            ).pipe(Effect.provide(caseContext))
          }).pipe(Effect.scoped),
      )

      // Each decision needs one real interpreter startup; independent questions own independent fixtures.
      for (const decision of ['denied', 'expired'] as const)
        layer(codeProcessLayer.pipe(Layer.provide(localCodeComputerLayer)))((it) => {
          it.effect(`${decision} program Approvals execute nothing`, () =>
            Effect.gen(function* () {
              const caseContext = yield* Layer.build(testLayer)
              return yield* Effect.scoped(
                Effect.gen(function* () {
                  const test = yield* fixture()
                  yield* (yield* ConnectionStore).begin(test.personal, {
                    service: serviceId,
                    name: null,
                    shared: false,
                  })
                  const store = yield* ApprovalStore
                  yield* run(test.personal, test.personalId, `await ${use('write')};`)
                  const approval = (yield* store.inThread(test.personalId))[0]
                  if (approval === undefined) return yield* Effect.die('No approval')
                  if (decision === 'denied')
                    yield* store.decide(test.personal, {
                      id: approval.id,
                      digest: approval.digest,
                      decision: ApprovalDecision.cases.Deny.make({}),
                    })
                  else {
                    yield* TestClock.adjust('25 hours')
                    expect(
                      Result.isFailure(
                        yield* Effect.result(
                          store.decide(test.personal, {
                            id: approval.id,
                            digest: approval.digest,
                            decision: ApprovalDecision.cases.AllowOnce.make({}),
                          }),
                        ),
                      ),
                    ).toBe(true)
                  }
                  expect(yield* Ref.get((yield* Observation).actions)).toEqual([])
                  return yield* Effect.void
                }),
              ).pipe(Effect.provide(caseContext))
            }).pipe(Effect.scoped),
          )
        })

      it.effect('a Never rule is terminal despite a guest catch and queued writes', () =>
        Effect.gen(function* () {
          const caseContext = yield* Layer.build(testLayer)
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const test = yield* fixture()
              yield* (yield* ConnectionStore).begin(test.personal, {
                service: serviceId,
                name: null,
                shared: false,
              })
              yield* (yield* RuleStore).create(test.personal, {
                action: 'Never update records',
                decision: 'Never',
                scope: RuleScope.cases.Personal.make({}),
              })
              const probe = yield* ConnectionProbe
              yield* Ref.set(probe.calls, 0)
              const outcome = yield* run(
                test.personal,
                test.personalId,
                `try {await Promise.allSettled([${use('write')},${use('write')}]);} catch(e) {await ${use('write')};}`,
              )
              expect(CodeOutcome.guards.Blocked(outcome)).toBe(true)
              expect(outcome).toHaveProperty('rule', 'Never update records')
              expect(yield* Ref.get(probe.calls)).toBe(0)
              expect(yield* (yield* ApprovalStore).inThread(test.personalId)).toEqual([])
            }),
          ).pipe(Effect.provide(caseContext))
        }).pipe(Effect.scoped),
      )
    })
  },
)

/** Infrastructure faults exercise bound dispatch directly, independently of host interpreter support. */
describe.skipIf(!testDatabaseConfigured)('Program pre-dispatch failures', () => {
  /** Availability replies are new code refusals; they are recorded once without private reasons. */
  standalone.effect.each(['personal browser', 'cloud browser'] as const)(
    'records one CallRefused for unavailable %s',
    (surface) =>
      Effect.gen(function* () {
        const caseContext = yield* Layer.build(testLayer)
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const test = yield* fixture()
            const logs = refusalLogs()
            const store = yield* ComputerStore
            const unavailable = ComputerStore.of({
              ...store,
              browse: () => Effect.fail(new ComputerNotReady({ reason: 'Private browser outage' })),
            })
            const input = {
              target:
                surface === 'personal browser'
                  ? BrowseTarget.cases.Person.make({})
                  : BrowseTarget.cases.Vivid.make({}),
              action: BrowserAction.cases.Open.make({ address: 'https://example.test' }),
              summary: 'Check availability',
            }
            const kind = 'browse'
            const outcome = yield* Effect.gen(function* () {
              const caseContext = yield* Layer.build(Layer.fresh(codeCallsLayer))
              return yield* Effect.gen(function* () {
                return yield* (yield* CodeCalls).bind({
                  person: test.personal.person.id,
                  thread: test.personalId,
                })(WorkerMessage.cases.Call.make({ id: 1, kind, input }))
              }).pipe(Effect.provide(caseContext))
            }).pipe(
              Effect.scoped,
              Effect.provideService(ComputerStore, unavailable),
              Effect.updateService(
                Logger.CurrentLoggers,
                (loggers) => new Set([...loggers, logs.capture]),
              ),
              Effect.scoped,
            )
            expect(outcome).toMatchObject({ end: 'refused', value: { ok: false } })
            expect(logs.recorded()).toHaveLength(1)
            expect(logs.recorded()[0]).toContain('vivid.refusal.kind=CallRefused')
            expect(logs.recorded()[0]).toContain(`vivid.refusal.call=${kind}`)
            expect(logs.recorded()[0]).not.toContain('Private')
          }),
        ).pipe(Effect.provide(caseContext))
      }).pipe(Effect.scoped),
  )

  /** Provider rejection travels through the real code-call seam without a second refusal. */
  standalone.effect('records exactly one ToolRejected for a rejected use_tool code call', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(testLayer)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* (yield* ConnectionStore).begin(test.personal, {
            service: serviceId,
            name: null,
            shared: false,
          })
          const executor = yield* Executor
          const logs = refusalLogs()
          const outcome = yield* Effect.gen(function* () {
            const caseContext = yield* Layer.build(Layer.fresh(codeCallsLayer))
            return yield* Effect.gen(function* () {
              return yield* (yield* CodeCalls).bind({
                person: test.personal.person.id,
                thread: test.personalId,
              })(
                WorkerMessage.cases.Call.make({
                  id: 1,
                  kind: 'use_tool',
                  input: {
                    account: 'Records',
                    tool: 'read',
                    input: {},
                    summary: 'Read',
                    rationale: '',
                  },
                }),
              )
            }).pipe(Effect.provide(caseContext))
          }).pipe(
            Effect.scoped,
            Effect.provideService(
              Executor,
              Executor.of({
                ...executor,
                call: () =>
                  Effect.succeed(
                    ExecutorCallOutcome.cases.Rejected.make({ message: 'Private rejection' }),
                  ),
              }),
            ),
            Effect.updateService(
              Logger.CurrentLoggers,
              (loggers) => new Set([...loggers, logs.capture]),
            ),
            Effect.scoped,
          )
          expect(outcome).toMatchObject({ end: 'refused', value: { ok: false } })
          expect(logs.recorded()).toHaveLength(1)
          expect(logs.recorded()[0]).toContain('vivid.refusal.kind=ToolRejected')
        }),
      ).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  /** Address policy is decided by the real PageReader before its refused reply reaches code. */
  standalone.effect('records exactly one PageRefused for a refused read_page code call', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(testLayer)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture()
          const logs = refusalLogs()
          const outcome = yield* (yield* CodeCalls)
            .bind({
              person: test.personal.person.id,
              thread: test.personalId,
            })(
              WorkerMessage.cases.Call.make({
                id: 1,
                kind: 'read_page',
                input: { address: 'file:///private' },
              }),
            )
            .pipe(
              Effect.updateService(
                Logger.CurrentLoggers,
                (loggers) => new Set([...loggers, logs.capture]),
              ),
              Effect.scoped,
            )
          expect(outcome).toMatchObject({ end: 'refused', value: { ok: false } })
          expect(logs.recorded()).toHaveLength(1)
          expect(logs.recorded()[0]).toContain('vivid.refusal.kind=PageRefused')
        }),
      ).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  /** This vocabulary has no authority-revocation case; a Blocked receipt must not invent a Gate refusal. */
  standalone.effect('authority revocation blocks without inventing a recorded Gate decision', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(testLayer)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture()
          const logs = refusalLogs()
          const outcome = yield* Effect.gen(function* () {
            const caseContext = yield* Layer.build(Layer.fresh(codeCallsLayer))
            return yield* Effect.gen(function* () {
              return yield* (yield* CodeCalls).bind({
                person: test.personal.person.id,
                thread: test.personalId,
              })(
                WorkerMessage.cases.Call.make({
                  id: 1,
                  kind: 'find_tools',
                  input: { query: 'read' },
                }),
              )
            }).pipe(Effect.provide(caseContext))
          }).pipe(
            Effect.scoped,
            Effect.provideService(
              CodeAuthority,
              CodeAuthority.of({
                refresh: () => Effect.fail(new CodeAuthorityRevoked({})),
              }),
            ),
            Effect.updateService(
              Logger.CurrentLoggers,
              (loggers) => new Set([...loggers, logs.capture]),
            ),
            Effect.scoped,
          )
          expect(CallOutcome.guards.Blocked(outcome)).toBe(true)
          expect(logs.recorded()).toEqual([])
        }),
      ).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )

  for (const kind of CodeCallKind.literals) {
    standalone.effect(
      `returns a refused ${kind} receipt when authority storage is unavailable`,
      () =>
        Effect.gen(function* () {
          const caseContext = yield* Layer.build(testLayer)
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const test = yield* fixture()
              const database = yield* Database
              const unavailable = Database.of({
                ...database,
                select: () => database.select(),
                run: () => Effect.fail(new DatabaseUnavailable({ message: 'isolated fault' })),
              })
              const logs = refusalLogs()
              const outcome = yield* Effect.gen(function* () {
                const caseContext = yield* Layer.build(
                  Layer.fresh(codeCallsLayer.pipe(Layer.provideMerge(codeAuthorityLayer))),
                )
                return yield* Effect.gen(function* () {
                  const calls = yield* CodeCalls
                  return yield* calls.bind({
                    person: test.personal.person.id,
                    thread: test.personalId,
                  })(WorkerMessage.cases.Call.make({ id: 1, kind, input: {} }))
                }).pipe(Effect.provide(caseContext))
              }).pipe(
                Effect.scoped,
                Effect.provideService(Database, unavailable),
                Effect.updateService(
                  Logger.CurrentLoggers,
                  (loggers) => new Set([...loggers, logs.capture]),
                ),
                Effect.scoped,
              )
              expect(CallOutcome.guards.Returned(outcome)).toBe(true)
              expect(outcome).toMatchObject({ end: 'refused', value: { ok: false } })
              const recorded = logs.recorded()
              expect(recorded).toHaveLength(1)
              expect(recorded[0]).toContain('vivid.refusal.kind=CallRefused')
              expect(recorded[0]).toContain(`vivid.refusal.call=${kind}`)
            }),
          ).pipe(Effect.provide(caseContext))
        }).pipe(Effect.scoped),
    )
  }
  standalone.effect(
    'returns discovery infrastructure failure to the program without claiming an action happened',
    () =>
      Effect.gen(function* () {
        const caseContext = yield* Layer.build(testLayer)
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* ConnectionStore
            yield* store.begin(test.personal, { service: serviceId, name: null, shared: false })
            const unavailable = ConnectionStore.of({
              ...store,
              tools: () =>
                Effect.fail(
                  new ServiceUnavailable({ service: 'connections', message: 'isolated fault' }),
                ),
            })
            const outcome = yield* Effect.gen(function* () {
              const caseContext = yield* Layer.build(Layer.fresh(codeCallsLayer))
              return yield* Effect.gen(function* () {
                return yield* (yield* CodeCalls).bind({
                  person: test.personal.person.id,
                  thread: test.personalId,
                })(
                  WorkerMessage.cases.Call.make({
                    id: 1,
                    kind: 'find_tools',
                    input: { query: 'read' },
                  }),
                )
              }).pipe(Effect.provide(caseContext))
            }).pipe(Effect.scoped, Effect.provideService(ConnectionStore, unavailable))
            expect(CallOutcome.guards.Returned(outcome)).toBe(true)
            expect(outcome).toMatchObject({ end: 'refused', value: { ok: false } })
          }),
        ).pipe(Effect.provide(caseContext))
      }).pipe(Effect.scoped),
  )
  standalone.effect('preserves the infrastructure tag when refreshing authority', () =>
    Effect.gen(function* () {
      const caseContext = yield* Layer.build(testLayer)
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          const outcome = yield* Effect.gen(function* () {
            const caseContext = yield* Layer.build(Layer.fresh(codeAuthorityLayer))
            return yield* Effect.gen(function* () {
              return yield* (yield* CodeAuthority)
                .refresh({ person: test.personal.person.id, thread: test.personalId })
                .pipe(Effect.flip)
            }).pipe(Effect.provide(caseContext))
          }).pipe(
            Effect.scoped,
            Effect.provideService(
              Database,
              Database.of({
                ...database,
                select: () => database.select(),
                run: () => Effect.fail(new DatabaseUnavailable({ message: 'isolated fault' })),
              }),
            ),
          )
          expect(outcome._tag).toBe('DatabaseUnavailable')
        }),
      ).pipe(Effect.provide(caseContext))
    }).pipe(Effect.scoped),
  )
})
