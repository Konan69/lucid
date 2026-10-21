import { deviceLayer } from '../computers/device.ts'
import { describe, expect, layer } from '@effect/vitest'
import { eq } from 'drizzle-orm'
import {
  ApprovalDecision,
  CodeOutcome,
  CodeFailure,
  RuleScope,
  DatabaseUnavailable,
  ServiceUnavailable,
  CodeCallKind,
  BrowseTarget,
  BrowserAction,
  SessionId,
  DisplaySource,
  DisplayProgramWaiting,
  FeedCardId,
  type RunDisplayCodeRequest,
  type DisplayCodeOutcome,
  type PersonId,
  type DisplayToolKind,
  type ThreadId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Context, Deferred, Effect, Fiber, Layer, Logger, Queue, Ref, Result, Schema } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { refusalLogs } from '../observability/testlogger.ts'
import type { Actor } from '../auth/access.ts'
import { membershipTable } from '../companies/tables.ts'
import { threads } from '../threads/tables.ts'
import { Database } from '../database/client.ts'
import { auditEntries } from '../audit/tables.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { absentMachineLayer } from '../computers/testing.ts'
import {
  ComputerAccess,
  ComputerNotReady,
  ComputerStore,
  computerMachineKey,
  computerStoreLayer,
} from '../computers/store.ts'
import { Executor, ExecutorCallOutcome } from '../connections/executor.ts'
import { ConnectionStore, ToolDiscovery } from '../connections/store.ts'
import {
  ConnectionProbe,
  connectionTestLayer,
  readTool,
  serviceId,
} from '../connections/testing.ts'
import { ApprovalStore } from '../approvals/store.ts'
import {
  fixture,
  history,
  textPart,
  recordRuns,
  Observation,
  trustTestLayer,
} from '../approvals/testing.ts'
import { Runtime } from '../runtime/client.ts'
import { FeedStore, feedStoreLayer } from '../feed/store.ts'
import { feedHandlers } from '../feed/handlers.ts'
import { cardIdOf } from '../feed/read.ts'
import { RunOrigin } from '@vivid/contracts'
import { CodeComputer } from './computer.ts'
import { RuleStore } from '../rules/store.ts'
import { CodeAuthority, CodeAuthorityRevoked, codeAuthorityLayer } from './authority.ts'
import { CodeCalls, codeCallsLayer } from './calls.ts'
import { codeHandlers } from './handlers.ts'
import { publicPageLayer } from './page.ts'
import { CallOutcome, CodeProcess, codeProcessLayer } from './process.ts'
import { WorkerMessage } from './protocol.ts'
import { localCodeComputerLayer } from './testing.ts'
import { codeSourceLayer } from './source.ts'

const isRepositoryInput = Schema.is(Schema.Struct({ repoName: Schema.String }))
const busyFailure = CodeFailure.cases.Busy.make({
  message: 'Vivid is busy with other work. Try again in a moment.',
})

const accounts = Layer.mergeAll(connectionTestLayer, trustTestLayer, absentMachineLayer)
const computers = computerStoreLayer.pipe(
  Layer.provideMerge(deviceLayer),
  Layer.provideMerge(accounts),
)
const dependencies = Layer.mergeAll(codeAuthorityLayer, publicPageLayer).pipe(
  Layer.provideMerge(computers),
)
const testLayer = codeCallsLayer.pipe(
  Layer.provideMerge(dependencies),
  Layer.provideMerge(feedStoreLayer),
  Layer.provideMerge(codeSourceLayer),
  Layer.provideMerge(Layer.mock(Runtime, history([]))),
)

/** Acquire Connection probes, approval observations and call bindings per case; their mutable recordings must stay isolated while the enclosing block shares the database and process supervisor. */
const withCalls = <A, E, R, Services, Failure, Requirements>(
  program: Effect.Effect<A, E, R>,
  callLayer: Layer.Layer<Services, Failure, Requirements>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(callLayer)
    return yield* program.pipe(Effect.provide(context))
  }).pipe(Effect.scoped)

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

/** Display authority comes from the reader's session, never Vivid's private Run token. */
const storedDisplay = Effect.fn('Test.StoredDisplay')(
  (actor: Actor, request: RunDisplayCodeRequest) =>
    codeHandlers.RunDisplayCode(request).pipe(
      Effect.provideService(
        AuthContext,
        AuthState.Person({
          person: actor.person,
          workspace: actor.workspace,
          sessionId: SessionId.make('display-reader-session'),
        }),
      ),
    ),
)

/** Only the external Flue transport is supplied; production source decoding and access checks run. */
const runDisplay = Effect.fn('Test.RunDisplayCode')(
  (actor: Actor, thread: ThreadId, kind: DisplayToolKind, code: string) =>
    withCalls(
      storedDisplay(actor, {
        code,
        summary: 'Work with records',
        source: DisplaySource.cases.ThreadMessage.make({
          thread,
          message: JSON.stringify([kind, code]),
        }),
        kind,
      }),
      Layer.mock(
        Runtime,
        history(
          [
            {
              id: JSON.stringify([kind, code]),
              submissionId: 'done',
              role: 'assistant',
              parts: textPart(
                `root = Text(data)\ndata = ${kind}("run_code", {code: ${JSON.stringify(code)}, summary: "Work with records"})`,
              ),
            },
          ],
          ['done'],
        ),
      ),
    ),
)

/** Each open has typed release/interruption signals, so no capacity proof waits on wall time. */
const displayHarness = Effect.fn('Test.displayHarness')(function* () {
  const computer = yield* CodeComputer
  const opened = yield* Queue.unbounded<{
    readonly person: PersonId
    readonly release: Deferred.Deferred<void>
    readonly interrupted: Deferred.Deferred<void>
  }>()
  const admitted = yield* Queue.unbounded<void>()
  const count = yield* Ref.make(0)
  const held = CodeComputer.of({
    open: Effect.fn('Test.holdComputer')(function* (person) {
      const release = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      yield* Ref.update(count, (n) => n + 1)
      yield* Queue.offer(opened, { person, release, interrupted })
      yield* Deferred.await(release).pipe(
        Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
      )
      return yield* computer.open(person)
    }),
  })
  const context = yield* Layer.build(
    Layer.fresh(codeProcessLayer).pipe(Layer.provide(Layer.succeed(CodeComputer, held))),
  )
  const process = Context.get(context, CodeProcess)
  // startImmediately registers a caller's RcMap reference before this acknowledgment is published.
  const observed = CodeProcess.of({
    ...process,
    runDisplay: Effect.fn('Test.observeDisplay')(function* (input, dispatch) {
      const fiber = yield* process
        .runDisplay(input, dispatch)
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Queue.offer(admitted, undefined)
      return yield* Fiber.join(fiber)
    }),
  })
  const start = Effect.fn('Test.startDisplay')(function* (
    actor: Actor,
    thread: ThreadId,
    kind: DisplayToolKind,
    code: string,
  ) {
    const fiber = yield* runDisplay(actor, thread, kind, code).pipe(
      Effect.provideService(CodeProcess, observed),
      Effect.forkChild,
    )
    yield* Effect.raceFirst(Queue.take(admitted), Fiber.join(fiber).pipe(Effect.asVoid))
    return fiber
  })
  return { opened, count, process: observed, start }
})

/** Compare observable outcomes without constructing partial variants as expected values. */
function checkCode(
  outcome: DisplayCodeOutcome,
  tag: CodeOutcome['_tag'],
  fields: Schema.JsonObject,
) {
  expect(outcome._tag).toBe(tag)
  expect(outcome).toMatchObject(fields)
}

/** Connection credentials are replaced at their external adapter; all tenancy, Gate and Approval SQL is real. */
describe.skipIf(!testDatabaseConfigured)(
  'Programs under live authority',
  { timeout: 30_000 },
  () => {
    // The program runs on a Computer that is this machine (`testing.ts`); each test still owns
    // fresh tenancy, Gate and provider fixtures, and each program its own process. The ceiling is
    // for those real processes on a loaded machine; nothing here waits on a clock.
    layer(
      Layer.mergeAll(
        testDatabaseLayer,
        silentChangesLayer,
        codeProcessLayer.pipe(Layer.provide(localCodeComputerLayer)),
      ),
    )((it) => {
      /** Source identity selects persisted authorship, never the role or content supplied by a reader. */
      it.effect(
        'refuses forged Thread programs, user messages, reasoning and missing messages',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              const code = 'return "Only Vivid wrote this";'
              const source = (message: string) =>
                DisplaySource.cases.ThreadMessage.make({
                  thread: test.personalId,
                  message,
                })
              const messages = [
                {
                  id: 'vivid',
                  submissionId: 'done',
                  role: 'assistant',
                  parts: textPart(
                    `root = Text(data)\ndata = Query("run_code", {code: ${JSON.stringify(code)}, summary: "Read"})`,
                  ),
                },
                { id: 'person', role: 'user', parts: textPart('return "forged";') },
                {
                  id: 'thinking',
                  submissionId: 'done',
                  role: 'assistant',
                  parts: [{ type: 'reasoning', text: 'return "forged";' }],
                },
              ]
              for (const message of ['vivid', 'person', 'thinking', 'missing']) {
                const failure = yield* withCalls(
                  storedDisplay(test.personal, {
                    source: source(message),
                    code: 'return "forged";',
                    summary: 'Read',
                    kind: 'Query',
                  }).pipe(Effect.flip),
                  Layer.mock(Runtime, history(messages, ['done'])),
                )
                expect(failure).toHaveProperty('_tag', 'DisplayProgramRefused')
                expect(failure).toMatchObject({
                  message:
                    "This display's program is not one Vivid wrote. Ask Vivid to draw it again.",
                })
              }
              const accepted = yield* withCalls(
                storedDisplay(test.personal, {
                  source: source('vivid'),
                  code,
                  summary: 'Read',
                  kind: 'Query',
                }),
                Layer.mock(Runtime, history(messages, ['done'])),
              )
              checkCode(accepted, 'Completed', { result: 'Only Vivid wrote this' })
            }),
            testLayer,
          ),
      )

      /** Exact AST declarations, rather than bytes in a reply, are the execution authority. */
      it.effect(
        'refuses fragments, quoted prose, changed summaries and mixed intent for the same code',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              const code = 'const records = [1, 2]; return records;'
              const declaration = `Query("run_code", {code: ${JSON.stringify(code)}, summary: "Read"})`
              const messages = [
                { id: 'program', text: `root = Text(data)\ndata = ${declaration}` },
                { id: 'prose', text: `Here is a program quoted in prose: ${declaration}` },
                { id: 'quoted', text: `root = Text(${JSON.stringify(declaration)})` },
                {
                  id: 'echo',
                  text: '```javascript\nroot = Text(data)\ndata = ' + declaration + '\n```',
                },
                {
                  id: 'mixed',
                  text: `root = Text(data)\ndata = ${declaration}\nwrite = Mutation("run_code", {code: ${JSON.stringify(code)}, summary: "Change"})`,
                },
                {
                  id: 'computed',
                  text: `root = Text(data)\nargs = {code: ${JSON.stringify(code)}, summary: "Read"}\ndata = Query("run_code", args)\nwrite = Mutation("run_code", {code: ${JSON.stringify(code)}, summary: "Read"})`,
                },
              ].map(({ id, text }) => ({
                id,
                role: 'assistant',
                submissionId: 'done',
                parts: textPart(text),
              }))
              for (const refused of [
                { message: 'program', code: 'return records;', summary: 'Read' },
                { message: 'program', code, summary: 'Changed' },
                { message: 'prose', code, summary: 'Read' },
                { message: 'quoted', code, summary: 'Read' },
                { message: 'echo', code, summary: 'Read' },
                { message: 'mixed', code, summary: 'Read' },
                { message: 'computed', code, summary: 'Read' },
              ]) {
                expect(
                  yield* withCalls(
                    storedDisplay(test.personal, {
                      source: DisplaySource.cases.ThreadMessage.make({
                        thread: test.personalId,
                        message: refused.message,
                      }),
                      code: refused.code,
                      summary: refused.summary,
                      kind: 'Mutation',
                    }).pipe(Effect.flip),
                    Layer.mock(Runtime, history(messages, ['done'])),
                  ),
                ).toHaveProperty('_tag', 'DisplayProgramRefused')
              }
              checkCode(
                yield* withCalls(
                  storedDisplay(test.personal, {
                    source: DisplaySource.cases.ThreadMessage.make({
                      thread: test.personalId,
                      message: 'program',
                    }),
                    code,
                    summary: 'Read',
                    kind: 'Query',
                  }),
                  Layer.mock(Runtime, history(messages, ['done'])),
                ),
                'Completed',
                { result: [1, 2] },
              )
            }),
            testLayer,
          ),
      )

      /** A forged Mutation hint cannot grant a draw-time Query the Gate's press policy. */
      it.effect('derives Query policy from storage even when the client claims Mutation', () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            yield* (yield* ConnectionStore).begin(test.personal, {
              from: 'Web',
              service: serviceId,
              name: null,
              shared: false,
            })
            const code = `return await ${use('write')};`
            const outcome = yield* withCalls(
              storedDisplay(test.personal, {
                source: DisplaySource.cases.ThreadMessage.make({
                  thread: test.personalId,
                  message: 'query',
                }),
                code,
                summary: 'Read',
                kind: 'Mutation',
              }),
              Layer.mock(
                Runtime,
                history(
                  [
                    {
                      id: 'query',
                      role: 'assistant',
                      submissionId: 'done',
                      parts: textPart(
                        `root = Text(data)\ndata = Query("run_code", {code: ${JSON.stringify(code)}, summary: "Read"})`,
                      ),
                    },
                  ],
                  ['done'],
                ),
              ),
            )
            checkCode(outcome, 'Completed', {
              result: {
                ok: false,
                reason: 'This display runs automatically. Use a button to make changes.',
              },
            })
            expect(yield* Ref.get((yield* ConnectionProbe).calls)).toBe(0)
            expect(yield* (yield* ApprovalStore).inThread(test.personalId)).toEqual([])
          }),
          testLayer,
        ),
      )

      /** Finality is authoritative, and only the parsed final message survives between draws. */
      it.effect(
        'waits for final storage, then caches declarations without caching an execution',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              const harness = yield* displayHarness()
              const final = yield* Ref.make(false)
              const reads = yield* Ref.make(0)
              const request = {
                source: DisplaySource.cases.ThreadMessage.make({
                  thread: test.personalId,
                  message: 'reply',
                }),
                code: 'return 1;',
                summary: 'Read',
                kind: 'Query' as const,
              }
              const runtime = Layer.mock(Runtime, {
                read: Effect.fn('Test.displayHistory')(function* () {
                  yield* Ref.update(reads, (n) => n + 1)
                  return yield* history(
                    [
                      {
                        id: 'reply',
                        role: 'assistant',
                        submissionId: 'submission',
                        parts: textPart(
                          'root = Text(data)\ndata = Query("run_code", {code: "return 1;", summary: "Read"})',
                        ),
                      },
                    ],
                    (yield* Ref.get(final)) ? ['submission'] : [],
                  ).read()
                }),
              })
              const context = yield* Layer.build(runtime)
              const draw = storedDisplay(test.personal, request).pipe(
                Effect.provide(context),
                Effect.provideService(CodeProcess, harness.process),
              )
              expect(yield* draw).toEqual(DisplayProgramWaiting.make({}))
              expect(yield* Ref.get(harness.count)).toBe(0)
              yield* Ref.set(final, true)
              for (const count of [1, 2]) {
                const reader = yield* draw.pipe(Effect.forkChild)
                yield* Deferred.succeed((yield* Queue.take(harness.opened)).release, undefined)
                checkCode(yield* Fiber.join(reader), 'Completed', { result: 1 })
                expect(yield* Ref.get(harness.count)).toBe(count)
              }
              expect(yield* Ref.get(reads)).toBe(3)
            }),
            testLayer.pipe(Layer.provideMerge(localCodeComputerLayer)),
          ),
      )

      /** A parsed final declaration never substitutes for Flue's current active-path authority. */
      it.effect.each(['removed', 'replaced', 'reset'] as const)(
        'refuses cached authority when the active response is %s',
        (change) =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              const request = {
                source: DisplaySource.cases.ThreadMessage.make({
                  thread: test.personalId,
                  message: 'reply',
                }),
                code: 'return 1;',
                summary: 'Read',
                kind: 'Query' as const,
              }
              const message = {
                id: 'reply',
                role: 'assistant',
                submissionId: 'submission',
                parts: textPart(
                  'root = Text(data)\ndata = Query("run_code", {code: "return 1;", summary: "Read"})',
                ),
              }
              const current = yield* Ref.make(history([message], ['submission'], 'first'))
              const runtime = Layer.mock(Runtime, {
                read: Effect.fn('Test.currentDisplayHistory')(function* () {
                  const snapshot = yield* Ref.get(current)
                  return yield* snapshot.read()
                }),
              })
              const context = yield* Layer.build(runtime)
              const draw = storedDisplay(test.personal, request).pipe(Effect.provide(context))
              checkCode(yield* draw, 'Completed', { result: 1 })
              const changed = {
                removed: history([], ['submission'], 'first'),
                replaced: history(
                  [{ ...message, parts: textPart('root = Text("Replacement response")') }],
                  ['submission'],
                  'first',
                ),
                reset: history([message], [], 'second'),
              }
              yield* Ref.set(current, changed[change])
              if (change === 'reset') {
                expect(yield* draw).toEqual(DisplayProgramWaiting.make({}))
                yield* Ref.set(current, history([message], ['submission'], 'second'))
                checkCode(yield* draw, 'Completed', { result: 1 })
              } else {
                expect(yield* draw.pipe(Effect.flip)).toMatchObject({
                  _tag: 'DisplayProgramRefused',
                })
              }
            }),
            testLayer,
          ),
      )

      /** A warm parser cache grants no access after a real Membership deletion. */
      it.effect('refuses a cached draw after its reader loses Thread access', () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            const harness = yield* displayHarness()
            const draw = runDisplay(test.member, test.companyId, 'Query', 'return 1;').pipe(
              Effect.provideService(CodeProcess, harness.process),
            )
            for (const count of [1, 2]) {
              const reader = yield* draw.pipe(Effect.forkChild)
              yield* Deferred.succeed((yield* Queue.take(harness.opened)).release, undefined)
              checkCode(yield* Fiber.join(reader), 'Completed', { result: 1 })
              expect(yield* Ref.get(harness.count)).toBe(count)
            }
            const database = yield* Database
            yield* database.run(
              database
                .delete(membershipTable)
                .where(eq(membershipTable.userId, test.member.person.id)),
            )
            expect(yield* draw.pipe(Effect.flip)).toMatchObject({
              _tag: 'NotFound',
              message: 'Thread not found',
            })
            expect(yield* Ref.get(harness.count)).toBe(2)
          }),
          testLayer.pipe(Layer.provideMerge(localCodeComputerLayer)),
        ),
      )

      /** Posting uses Vivid's real handler; execution reloads that same persisted card for its reader. */
      it.effect(
        'refuses forged Feed programs and other readers, and runs only the stored post',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              const database = yield* Database
              yield* database.run(
                database
                  .update(threads)
                  .set({ place: 'Background' })
                  .where(eq(threads.id, test.personalId)),
              )
              yield* recordRuns(test.personalId, [
                {
                  id: 'posting',
                  personId: test.personal.person.id,
                  working: true,
                  origin: RunOrigin.cases.Watch.make({
                    person: test.summary,
                    watchName: 'Records',
                  }),
                },
              ])
              const code = 'return "A stored Feed program";'
              const display = `root = Text(data)\ndata = Query("run_code", {code: ${JSON.stringify(code)}, summary: "Read"})`
              yield* feedHandlers
                .Post({ title: 'Records', words: 'Read the result', display, actions: [] })
                .pipe(
                  Effect.provideService(
                    AuthContext,
                    AuthState.Vivid({
                      person: test.personal.person,
                      workspace: test.personal.workspace,
                      threadId: test.personalId,
                    }),
                  ),
                )
              const request = {
                source: DisplaySource.cases.FeedPost.make({ post: cardIdOf(test.personalId) }),
                code,
                summary: 'Read',
                kind: 'Query' as const,
              }
              expect(
                yield* storedDisplay(test.personal, { ...request, code: 'return "forged";' }).pipe(
                  Effect.flip,
                ),
              ).toHaveProperty('_tag', 'DisplayProgramRefused')
              expect(yield* storedDisplay(test.other, request).pipe(Effect.flip)).toHaveProperty(
                '_tag',
                'DisplayProgramRefused',
              )
              expect(
                yield* storedDisplay(test.personal, {
                  ...request,
                  source: DisplaySource.cases.FeedPost.make({ post: FeedCardId.make('missing') }),
                }).pipe(Effect.flip),
              ).toHaveProperty('_tag', 'DisplayProgramRefused')
              checkCode(yield* storedDisplay(test.personal, request), 'Completed', {
                result: 'A stored Feed program',
              })
              // A follow-up replaces the post. Its predecessor immediately loses execution authority.
              yield* (yield* FeedStore).post({
                person: test.personal.person.id,
                thread: test.personalId,
                request: { title: 'New', words: 'Changed', display: null, actions: [] },
              })
              expect(yield* storedDisplay(test.personal, request).pipe(Effect.flip)).toHaveProperty(
                '_tag',
                'DisplayProgramRefused',
              )
            }),
            testLayer,
          ),
      )

      /** Existing audit attribution keeps Vivid authorship and the reader responsible for the call. */
      it.effect(
        'attributes a shared Thread display action to Vivid for the triggering Person',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              const database = yield* Database
              yield* database.run(
                database
                  .update(threads)
                  .set({ audience: 'company' })
                  .where(eq(threads.id, test.companyId)),
              )
              yield* (yield* ConnectionStore).begin(test.owner, {
                from: 'Web',
                service: serviceId,
                name: null,
                shared: false,
              })
              yield* (yield* RuleStore).create(test.owner, {
                action: 'Never update records',
                decision: 'Never',
                scope: RuleScope.cases.Personal.make({}),
              })
              const outcome = yield* runDisplay(
                test.owner,
                test.companyId,
                'Mutation',
                `return await ${use('write')};`,
              )
              checkCode(outcome, 'Blocked', {})
              const rows = yield* database.run(
                database
                  .select()
                  .from(auditEntries)
                  .where(eq(auditEntries.threadId, test.companyId)),
              )
              expect(rows).toHaveLength(1)
              expect(rows[0]).toHaveProperty('event._tag', 'ActionBlocked')
              expect(rows[0]).toMatchObject({
                personId: test.owner.person.id,
                by: 'vivid',
                threadId: test.companyId,
              })
              expect(yield* Ref.get((yield* ConnectionProbe).calls)).toBe(0)
            }),
            testLayer,
          ),
      )

      /** Admission is observed through real handlers; only the external Computer opening is held. */
      it.effect('isolates readers, queues four FIFO draws and preserves all RunCode permits', () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            const harness = yield* displayHarness()
            const first = yield* harness.start(test.personal, test.personalId, 'Query', 'return 1;')
            const opening = yield* Queue.take(harness.opened)
            const duplicate = yield* harness.start(
              test.personal,
              test.personalId,
              'Query',
              'return 1;',
            )
            const second = yield* harness.start(
              test.personal,
              test.personalId,
              'Query',
              'return 2;',
            )
            const another = yield* Queue.take(harness.opened)
            const queued = yield* Effect.forEach([3, 4, 5, 6], (n) =>
              harness.start(test.personal, test.personalId, 'Query', `return ${n};`),
            )
            checkCode(
              yield* Fiber.join(
                yield* harness.start(test.personal, test.personalId, 'Query', 'return 7;'),
              ),
              'Failed',
              {
                failure: busyFailure,
                calls: [],
              },
            )
            // A second Person has independent admission while all six of the first Person's keys live.
            const peer = yield* harness.start(test.other, test.otherId, 'Query', 'return 8;')
            const peerOpening = yield* Queue.take(harness.opened)
            expect(peerOpening.person).toBe(test.other.person.id)
            yield* Deferred.succeed(peerOpening.release, undefined)
            checkCode(yield* Fiber.join(peer), 'Completed', { result: 8 })
            const extra = yield* fixture()
            const vivid = yield* Effect.forEach(
              [
                { actor: test.personal, thread: test.personalId },
                { actor: test.member, thread: test.companyId },
                { actor: test.other, thread: test.otherId },
                { actor: extra.personal, thread: extra.personalId },
              ],
              ({ actor, thread }) =>
                Effect.gen(function* () {
                  const fiber = yield* run(actor, thread, 'return 9;').pipe(
                    Effect.provideService(CodeProcess, harness.process),
                    Effect.forkChild,
                  )
                  return { fiber, opening: yield* Queue.take(harness.opened) }
                }),
            )
            checkCode(
              yield* run(extra.member, extra.companyId, 'return 10;').pipe(
                Effect.provideService(CodeProcess, harness.process),
              ),
              'Failed',
              { failure: busyFailure },
            )
            yield* Deferred.succeed(opening.release, undefined)
            checkCode(yield* Fiber.join(first), 'Completed', { result: 1 })
            checkCode(yield* Fiber.join(duplicate), 'Completed', { result: 1 })
            for (const [index, fiber] of queued.entries()) {
              const next = yield* Queue.take(harness.opened)
              expect(next.person).toBe(test.personal.person.id)
              yield* Deferred.succeed(next.release, undefined)
              checkCode(yield* Fiber.join(fiber), 'Completed', { result: index + 3 })
            }
            yield* Deferred.succeed(another.release, undefined)
            checkCode(yield* Fiber.join(second), 'Completed', { result: 2 })
            for (const request of vivid) {
              yield* Deferred.succeed(request.opening.release, undefined)
              checkCode(yield* Fiber.join(request.fiber), 'Completed', { result: 9 })
            }
            expect(yield* Ref.get(harness.count)).toBe(11)
            const redraw = yield* harness.start(
              test.personal,
              test.personalId,
              'Query',
              'return 1;',
            )
            yield* Deferred.succeed((yield* Queue.take(harness.opened)).release, undefined)
            checkCode(yield* Fiber.join(redraw), 'Completed', { result: 1 })
            expect(yield* Ref.get(harness.count)).toBe(12)
          }),
          testLayer.pipe(Layer.provideMerge(localCodeComputerLayer)),
        ),
      )

      /** Unmounting the first reader cannot own another reader's execution or queued result. */
      it.effect(
        'keeps shared execution for a surviving reader and interrupts only the last reader',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              const harness = yield* displayHarness()
              const first = yield* harness.start(
                test.personal,
                test.personalId,
                'Query',
                'return 1;',
              )
              const opening = yield* Queue.take(harness.opened)
              const duplicate = yield* harness.start(
                test.personal,
                test.personalId,
                'Query',
                'return 1;',
              )
              yield* Fiber.interrupt(first)
              expect(yield* Deferred.isDone(opening.interrupted)).toBe(false)
              yield* Deferred.succeed(opening.release, undefined)
              checkCode(yield* Fiber.join(duplicate), 'Completed', { result: 1 })
              expect(yield* Ref.get(harness.count)).toBe(1)
              const abandoned = yield* harness.start(
                test.personal,
                test.personalId,
                'Query',
                'return 2;',
              )
              const last = yield* Queue.take(harness.opened)
              yield* Fiber.interrupt(abandoned)
              yield* Deferred.await(last.interrupted)
              const fresh = yield* harness.start(
                test.personal,
                test.personalId,
                'Query',
                'return 2;',
              )
              yield* Deferred.succeed((yield* Queue.take(harness.opened)).release, undefined)
              checkCode(yield* Fiber.join(fresh), 'Completed', { result: 2 })
              expect(yield* Ref.get(harness.count)).toBe(3)
            }),
            testLayer.pipe(Layer.provideMerge(localCodeComputerLayer)),
          ),
      )

      it.effect(
        'a display Query refuses a writing Integration call without sending it or creating an Approval',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              yield* (yield* ConnectionStore).begin(test.personal, {
                from: 'Web',
                service: serviceId,
                name: null,
                shared: false,
              })
              const outcome = yield* runDisplay(
                test.personal,
                test.personalId,
                'Query',
                `return await ${use('write')};`,
              )
              expect(CodeOutcome.guards.Completed(outcome)).toBe(true)
              expect(outcome).toMatchObject({
                result: {
                  ok: false,
                  reason: 'This display runs automatically. Use a button to make changes.',
                },
                calls: [{ kind: 'use_tool', end: 'refused' }],
              })
              expect(yield* Ref.get((yield* ConnectionProbe).calls)).toBe(0)
              expect(yield* (yield* ApprovalStore).inThread(test.personalId)).toEqual([])
            }),
            testLayer,
          ),
      )

      it.effect(
        'a display Query rechecks the effect when discovery changes after name resolution',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              const store = yield* ConnectionStore
              yield* store.begin(test.personal, {
                from: 'Web',
                service: serviceId,
                name: null,
                shared: false,
              })
              const discoveries = yield* Ref.make(0)
              const changing = ConnectionStore.of({
                ...store,
                tools: Effect.fn('Test.changingDiscovery')(function* () {
                  const count = yield* Ref.updateAndGet(discoveries, (value) => value + 1)
                  return ToolDiscovery.cases.Ready.make({
                    tools: [{ ...readTool, effect: count === 1 ? 'read' : 'write' }],
                  })
                }),
              })
              const outcome = yield* withCalls(
                runDisplay(test.personal, test.personalId, 'Query', `return await ${use('read')};`),
                Layer.fresh(codeCallsLayer),
              ).pipe(Effect.provideService(ConnectionStore, changing))
              expect(CodeOutcome.guards.Completed(outcome)).toBe(true)
              expect(outcome).toHaveProperty('result', {
                ok: false,
                reason: 'This display runs automatically. Use a button to make changes.',
                problems: [],
              })
              expect(yield* Ref.get((yield* ConnectionProbe).calls)).toBe(0)
              expect(yield* (yield* ApprovalStore).inThread(test.personalId)).toEqual([])
            }),
            testLayer,
          ),
      )

      it.effect('a display Mutation still asks the Gate before a writing Integration call', () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            yield* (yield* ConnectionStore).begin(test.personal, {
              from: 'Web',
              service: serviceId,
              name: null,
              shared: false,
            })
            const outcome = yield* runDisplay(
              test.personal,
              test.personalId,
              'Mutation',
              `return await ${use('write')};`,
            )
            expect(CodeOutcome.guards.ApprovalRequired(outcome)).toBe(true)
            expect(outcome).toMatchObject({ calls: [{ kind: 'use_tool', end: 'needs approval' }] })
            expect(yield* Ref.get((yield* ConnectionProbe).calls)).toBe(0)
            expect(yield* (yield* ApprovalStore).inThread(test.personalId)).toHaveLength(1)
          }),
          testLayer,
        ),
      )

      for (const kind of ['Query', 'Mutation'] as const) {
        it.effect(`a display ${kind} returns the program's selected read result`, () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              yield* (yield* ConnectionStore).begin(test.personal, {
                from: 'Web',
                service: serviceId,
                name: null,
                shared: false,
              })
              const outcome = yield* runDisplay(
                test.personal,
                test.personalId,
                kind,
                `return await ${use('read')};`,
              )
              expect(CodeOutcome.guards.Completed(outcome)).toBe(true)
              expect(outcome).toMatchObject({ result: { ok: true }, calls: [{ end: 'completed' }] })
              expect(yield* Ref.get((yield* ConnectionProbe).calls)).toBe(1)
            }),
            testLayer,
          ),
        )
        it.effect(`a display ${kind} refuses a reader outside the Thread audience`, () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              const failure = yield* runDisplay(
                test.other,
                test.personalId,
                kind,
                'return "must not run";',
              ).pipe(Effect.flip)
              expect(failure).toHaveProperty('_tag', 'NotFound')
            }),
            testLayer,
          ),
        )
      }

      it.effect('a display Query refuses browser actions before using the Computer browser', () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            const outcome = yield* runDisplay(
              test.personal,
              test.personalId,
              'Query',
              'return await tools.browse({});',
            )
            expect(CodeOutcome.guards.Completed(outcome)).toBe(true)
            expect(outcome).toMatchObject({
              result: {
                ok: false,
                reason: 'This display runs automatically. Use a button to use the browser.',
              },
              calls: [{ kind: 'browse', end: 'refused' }],
            })
          }),
          testLayer,
        ),
      )

      it.effect('a display Query refuses page reads before making a network request', () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            const outcome = yield* runDisplay(
              test.personal,
              test.personalId,
              'Query',
              'return await tools.read_page({address:"https://example.com/"});',
            )
            expect(CodeOutcome.guards.Completed(outcome)).toBe(true)
            expect(outcome).toMatchObject({
              result: {
                ok: false,
                reason: 'This display runs automatically. Use a button to read a page.',
              },
              calls: [{ kind: 'read_page', end: 'refused' }],
            })
          }),
          testLayer,
        ),
      )

      it.effect('Vivid cannot invoke the reader-only display RPC', () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            const failure = yield* codeHandlers
              .RunDisplayCode({
                code: 'return 1',
                summary: 'Read',
                source: DisplaySource.cases.ThreadMessage.make({
                  thread: test.personalId,
                  message: 'vivid-display',
                }),
                kind: 'Query',
              })
              .pipe(
                Effect.provideService(
                  AuthContext,
                  AuthState.Vivid({
                    person: test.personal.person,
                    workspace: test.personal.workspace,
                    threadId: test.personalId,
                  }),
                ),
                Effect.flip,
              )
            expect(failure).toHaveProperty('_tag', 'Forbidden')
          }),
          testLayer,
        ),
      )

      it.effect(
        'composes real named Connection calls and a gated Computer command with only selected results returned',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              yield* (yield* ConnectionStore).begin(test.personal, {
                from: 'Web',
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
              const outcome = yield* withCalls(
                run(
                  test.personal,
                  test.personalId,
                  `const found=await tools.find_tools({query:"read"}); const tool=found.tools[0];
      const first=await tools.use_tool({account:tool.account,tool:tool.tool,input:{},summary:"Read first page",rationale:"Find records"});
      const [left,right]=await Promise.all([1,2].map(page=>tools.use_tool({account:tool.account,tool:tool.tool,input:{cursor:first.output.cursor,page},summary:"Read next page",rationale:"Find records"})));
      return {chosen:left.output.rows.filter(row=>row.value>497).map(row=>row.value),count:right.output.rows.length};`,
                ),
                Layer.fresh(codeCallsLayer),
              ).pipe(
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
              // The two next-page calls run in parallel; both inputs must arrive exactly once,
              // but the transport does not promise which concurrent request arrives first.
              const submitted = yield* Ref.get(inputs)
              expect(submitted).toHaveLength(3)
              expect(submitted).toEqual(
                expect.arrayContaining([
                  {},
                  { cursor: 'next-page', page: 1 },
                  { cursor: 'next-page', page: 2 },
                ]),
              )
            }),
            testLayer,
          ),
      )

      it.effect(
        'returns validation problems to a program and accepts its corrected next call',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              yield* (yield* ConnectionStore).begin(test.personal, {
                from: 'Web',
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
              const outcome = yield* withCalls(
                run(
                  test.personal,
                  test.personalId,
                  `const first=await ${use('read')}; const next=await tools.use_tool({account:"Records",tool:"read",input:{repoName:"facebook/react"},summary:"Read",rationale:"Answer"}); return {first,next};`,
                ),
                Layer.fresh(codeCallsLayer),
              ).pipe(Effect.provideService(Executor, provider))
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
            testLayer,
          ),
      )

      it.effect(
        'keeps colliding personal account names scoped and rejects forged ownership fields',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              const store = yield* ConnectionStore
              yield* store.begin(test.personal, {
                from: 'Web',
                service: serviceId,
                name: 'Records',
                shared: false,
              })
              yield* store.begin(test.other, {
                from: 'Web',
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
            testLayer,
          ),
      )

      for (const revocation of ['Membership', 'Thread visibility'] as const)
        it.effect(
          `refreshes ${revocation} after the dispatch barrier and refuses the next queued call`,
          () =>
            withCalls(
              Effect.gen(function* () {
                const test = yield* fixture()
                yield* (yield* ConnectionStore).begin(test.owner, {
                  from: 'Web',
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
                const program = withCalls(
                  run(
                    test.member,
                    test.companyId,
                    `await ${use('read')}; return await ${use('read')};`,
                  ),
                  Layer.fresh(codeCallsLayer),
                ).pipe(Effect.provideService(Executor, controlled))
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
              testLayer,
            ),
        )

      it.effect('refuses shared Connection writes', () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* ConnectionStore
            yield* store.begin(test.owner, {
              from: 'Web',
              service: serviceId,
              name: null,
              shared: true,
            })
            const probe = yield* ConnectionProbe
            const before = yield* Ref.get(probe.calls)
            const shared = yield* run(test.member, test.companyId, `return await ${use('write')};`)
            expect(shared.calls.map((call) => call.end)).toEqual(['refused'])
            expect(yield* Ref.get(probe.calls)).toBe(before)
            expect(yield* (yield* ApprovalStore).inThread(test.companyId)).toEqual([])
          }),
          testLayer,
        ),
      )

      it.effect('asks before personal reads enter a shared Thread', () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* ConnectionStore
            yield* store.begin(test.personal, {
              from: 'Web',
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
          testLayer,
        ),
      )

      it.effect(
        'stores the exact first action, closes queued effects, and two Approval answers execute once',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              yield* (yield* ConnectionStore).begin(test.personal, {
                from: 'Web',
                service: serviceId,
                name: null,
                shared: false,
              })
              const probe = yield* ConnectionProbe
              yield* Ref.set(probe.calls, 0)
              const outcome = yield* run(
                test.personal,
                test.personalId,
                `try {await Promise.all([${use('write')},${use('write')}]);} finally {await ${use('write')};}`,
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
            testLayer,
          ),
      )

      it.effect(
        'retains an earlier Connection receipt when the next action asks for Approval',
        () =>
          withCalls(
            Effect.gen(function* () {
              const test = yield* fixture()
              yield* (yield* ConnectionStore).begin(test.personal, {
                from: 'Web',
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
              expect(outcome.calls.map((call) => call.end)).toEqual(['completed', 'needs approval'])
              expect(yield* Ref.get(probe.calls)).toBe(1)
            }),
            testLayer,
          ),
      )

      // Each decision needs one real interpreter startup; independent questions own independent fixtures.
      for (const decision of ['denied', 'expired'] as const)
        layer(
          Layer.merge(
            testDatabaseLayer,
            codeProcessLayer.pipe(Layer.provide(localCodeComputerLayer)),
          ),
        )(`Clock for ${decision} program Approval`, (it) => {
          it.effect(`${decision} program Approvals execute nothing`, () =>
            withCalls(
              Effect.gen(function* () {
                const test = yield* fixture()
                yield* (yield* ConnectionStore).begin(test.personal, {
                  from: 'Web',
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
              testLayer,
            ),
          )
        })

      it.effect('a Never rule is terminal despite a guest catch and queued writes', () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            yield* (yield* ConnectionStore).begin(test.personal, {
              from: 'Web',
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
              `try {await Promise.all([${use('write')},${use('write')}]);} catch(e) {await ${use('write')};}`,
            )
            expect(CodeOutcome.guards.Blocked(outcome)).toBe(true)
            expect(outcome).toHaveProperty('rule', 'Never update records')
            expect(yield* Ref.get(probe.calls)).toBe(0)
            expect(yield* (yield* ApprovalStore).inThread(test.personalId)).toEqual([])
          }),
          testLayer,
        ),
      )
    })
  },
)

/** Infrastructure faults exercise bound dispatch directly, independently of host interpreter support. */
describe.skipIf(!testDatabaseConfigured)('Program pre-dispatch failures', () => {
  /** Availability replies are new code refusals; they are recorded once without private reasons. */
  layer(Layer.merge(testDatabaseLayer, silentChangesLayer))((it) => {
    it.effect.each(['personal browser', 'cloud browser'] as const)(
      'records one CallRefused for unavailable %s',
      (surface) =>
        withCalls(
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
            const outcome = yield* withCalls(
              Effect.gen(function* () {
                return yield* (yield* CodeCalls).bind({
                  person: test.personal.person.id,
                  thread: test.personalId,
                })(WorkerMessage.cases.Call.make({ id: 1, kind, input }))
              }),
              Layer.fresh(codeCallsLayer),
            ).pipe(
              Effect.provideService(ComputerStore, unavailable),
              Effect.updateService(
                Logger.CurrentLoggers,
                (loggers) => new Set([...loggers, logs.capture]),
              ),
            )
            expect(outcome).toMatchObject({ end: 'refused', value: { ok: false } })
            expect(logs.recorded()).toHaveLength(1)
            expect(logs.recorded()[0]).toContain('vivid.refusal.kind=CallRefused')
            expect(logs.recorded()[0]).toContain(`vivid.refusal.call=${kind}`)
            expect(logs.recorded()[0]).not.toContain('Private')
          }),
          testLayer,
        ),
    )

    /** Provider rejection travels through the real code-call seam without a second refusal. */
    it.effect('records exactly one ToolRejected for a rejected use_tool code call', () =>
      withCalls(
        Effect.gen(function* () {
          const test = yield* fixture()
          yield* (yield* ConnectionStore).begin(test.personal, {
            from: 'Web',
            service: serviceId,
            name: null,
            shared: false,
          })
          const executor = yield* Executor
          const logs = refusalLogs()
          const outcome = yield* withCalls(
            Effect.gen(function* () {
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
            }),
            Layer.fresh(codeCallsLayer),
          ).pipe(
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
          )
          expect(outcome).toMatchObject({ end: 'refused', value: { ok: false } })
          expect(logs.recorded()).toHaveLength(1)
          expect(logs.recorded()[0]).toContain('vivid.refusal.kind=ToolRejected')
        }),
        testLayer,
      ),
    )

    /** Address policy is decided by the real PageReader before its refused reply reaches code. */
    it.effect('records exactly one PageRefused for a refused read_page code call', () =>
      withCalls(
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
        testLayer,
      ),
    )

    /** This vocabulary has no authority-revocation case; a Blocked receipt must not invent a Gate refusal. */
    it.effect('authority revocation blocks without inventing a recorded Gate decision', () =>
      withCalls(
        Effect.gen(function* () {
          const test = yield* fixture()
          const logs = refusalLogs()
          const outcome = yield* withCalls(
            Effect.gen(function* () {
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
            }),
            Layer.fresh(codeCallsLayer),
          ).pipe(
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
          )
          expect(CallOutcome.guards.Blocked(outcome)).toBe(true)
          expect(logs.recorded()).toEqual([])
        }),
        testLayer,
      ),
    )

    for (const kind of CodeCallKind.literals) {
      it.effect(`returns a refused ${kind} receipt when authority storage is unavailable`, () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            const database = yield* Database
            const unavailable = Database.of({
              ...database,
              select: () => database.select(),
              run: () => Effect.fail(new DatabaseUnavailable({ message: 'isolated fault' })),
            })
            const logs = refusalLogs()
            const outcome = yield* withCalls(
              Effect.gen(function* () {
                const calls = yield* CodeCalls
                return yield* calls.bind({
                  person: test.personal.person.id,
                  thread: test.personalId,
                })(WorkerMessage.cases.Call.make({ id: 1, kind, input: {} }))
              }),
              Layer.fresh(codeCallsLayer.pipe(Layer.provideMerge(codeAuthorityLayer))),
            ).pipe(
              Effect.provideService(Database, unavailable),
              Effect.updateService(
                Logger.CurrentLoggers,
                (loggers) => new Set([...loggers, logs.capture]),
              ),
            )
            expect(CallOutcome.guards.Returned(outcome)).toBe(true)
            expect(outcome).toMatchObject({ end: 'refused', value: { ok: false } })
            const recorded = logs.recorded()
            expect(recorded).toHaveLength(1)
            expect(recorded[0]).toContain('vivid.refusal.kind=CallRefused')
            expect(recorded[0]).toContain(`vivid.refusal.call=${kind}`)
          }),
          testLayer,
        ),
      )
    }
    it.effect(
      'returns discovery infrastructure failure to the program without claiming an action happened',
      () =>
        withCalls(
          Effect.gen(function* () {
            const test = yield* fixture()
            const store = yield* ConnectionStore
            yield* store.begin(test.personal, {
              from: 'Web',
              service: serviceId,
              name: null,
              shared: false,
            })
            const unavailable = ConnectionStore.of({
              ...store,
              tools: () =>
                Effect.fail(
                  new ServiceUnavailable({ service: 'connections', message: 'isolated fault' }),
                ),
            })
            const outcome = yield* withCalls(
              Effect.gen(function* () {
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
              }),
              Layer.fresh(codeCallsLayer),
            ).pipe(Effect.provideService(ConnectionStore, unavailable))
            expect(CallOutcome.guards.Returned(outcome)).toBe(true)
            expect(outcome).toMatchObject({ end: 'refused', value: { ok: false } })
          }),
          testLayer,
        ),
    )
    it.effect('preserves the infrastructure tag when refreshing authority', () =>
      withCalls(
        Effect.gen(function* () {
          const test = yield* fixture()
          const database = yield* Database
          const outcome = yield* withCalls(
            Effect.gen(function* () {
              return yield* (yield* CodeAuthority)
                .refresh({ person: test.personal.person.id, thread: test.personalId })
                .pipe(Effect.flip)
            }),
            Layer.fresh(codeAuthorityLayer),
          ).pipe(
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
        testLayer,
      ),
    )
  })
})
