import { describe, expect, it } from '@effect/vitest'
import {
  Memory,
  MemoryId,
  MemoryScope,
  NotFound,
  PersonId,
  PersonSummary,
  ThreadId,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Layer, Option, Predicate, Queue, Schema } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import type * as RpcMessage from 'effect/unstable/rpc/RpcMessage'
import { memoryTools } from './memory.ts'
import { Scope, toolRunner } from './scope.ts'

const reference = 'a393356d-f39d-44a7-b5e2-9aaefc38b8f2'
const memory = Memory.make({
  id: MemoryId.make(reference),
  kind: 'preference',
  content: 'Dami prefers morning meetings.',
  scope: MemoryScope.cases.Person.make({}),
  learnedIn: ThreadId.make('MARK-learned'),
  learnedFrom: PersonSummary.make({ id: PersonId.make('MARK-person'), name: 'Dami', image: null }),
  createdAt: 1,
  updatedAt: 1,
})
const corrected = Memory.make({
  ...memory,
  id: MemoryId.make('MARK-new-version'),
  content: 'Dami prefers afternoon meetings.',
})
const context = {
  toolCallId: 'MARK-call',
  signal: new AbortController().signal,
  log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
}
/** Flue permits several output shapes; assert the actual Vivid runner's JSON receipt at that boundary. */
const decodeOutput = Schema.decodeUnknownEffect(
  Schema.Struct({ output: Schema.Json, terminate: Schema.Boolean }),
)
type RpcExit = RpcMessage.ResponseExit<RpcGroup.Rpcs<typeof VividRpc>>['exit']

/** The real Flue callback and generated RPC client run together; only transport responses are controlled. */
const fixture = Effect.fn('MemoryToolsTest.fixture')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
  })
  const layer = Layer.succeed(
    Scope,
    Scope.of({
      acting: { personId: PersonId.make('MARK-person'), threadId: ThreadId.make('MARK-thread') },
      client: rpc.client,
      folder: Option.none(),
    }),
  )
  const [, , forget, correct] = memoryTools(toolRunner(layer))
  /** Compare server-bound requests while leaving all record references inside this transport seam. */
  const reply = Effect.fn('MemoryToolsTest.reply')(function* (
    tag: string,
    payload: Schema.Json,
    exit: RpcExit,
  ) {
    const request = yield* Queue.take(requests)
    if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected an RPC request')
    expect(request.tag).toBe(tag)
    expect(request.payload).toEqual(payload)
    yield* rpc.write({
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
      _tag: 'Exit',
      clientId: 0,
      requestId: request.id,
      exit,
    })
  })
  return {
    requests,
    reply,
    forget: (what: string) =>
      Effect.promise(() => Promise.resolve(forget.run({ ...context, data: { what } }))).pipe(
        Effect.flatMap(decodeOutput),
      ),
    correct: (was: string, now: string) =>
      Effect.promise(() => Promise.resolve(correct.run({ ...context, data: { was, now } }))).pipe(
        Effect.flatMap(decodeOutput),
      ),
  }
})

/** All successful, ambiguous and refused outputs pass through the real model projection and runner. */
function wordsOnly(output: Schema.Json) {
  expect(JSON.stringify(output)).not.toMatch(
    /MARK-|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|"id"/iu,
  )
}

describe('conversational memory edits', () => {
  it.effect(
    'lets the Person select an exact statement from a preview without choosing a semantic rank',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* fixture()
          const respond = Effect.fn('MemoryToolsTest.selection')(function* () {
            yield* tools.reply(
              'Recall',
              { query: memory.content, limit: 100 },
              Exit.succeed({ memories: [corrected, memory] }),
            )
            yield* tools.reply('ForgetMemory', { id: memory.id }, Exit.succeed(undefined))
          })
          const [result] = yield* Effect.all([tools.forget(memory.content), respond()], {
            concurrency: 2,
          })
          expect(result.output).toEqual({ ok: true, forgot: memory.content })
          wordsOnly(result.output)
        }),
      ),
  )

  it.effect(
    'a sole nonmatching semantic hit is previewed without forgetting or correcting it',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* fixture()
          for (const operation of [
            tools.forget('lunch'),
            tools.correct('lunch', corrected.content),
          ]) {
            const [result] = yield* Effect.all(
              [
                operation,
                tools.reply(
                  'Recall',
                  { query: 'lunch', limit: 100 },
                  Exit.succeed({ memories: [memory] }),
                ),
              ],
              { concurrency: 2 },
            )
            expect(result.output).toMatchObject({ ok: false, matches: [memory.content] })
            expect(yield* Queue.size(tools.requests)).toBe(0)
            wordsOnly(result.output)
          }
        }),
      ),
  )

  it.effect('an exact statement containing all can be forgotten', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        const statement = Memory.make({ ...memory, content: 'Dami handles all vendor invoices' })
        const respond = Effect.fn('MemoryToolsTest.all')(function* () {
          yield* tools.reply(
            'Recall',
            { query: statement.content, limit: 100 },
            Exit.succeed({ memories: [statement] }),
          )
          yield* tools.reply('ForgetMemory', { id: statement.id }, Exit.succeed(undefined))
        })
        const [result] = yield* Effect.all([tools.forget(statement.content), respond()], {
          concurrency: 2,
        })
        expect(result.output).toEqual({ ok: true, forgot: statement.content })
      }),
    ),
  )

  it.effect(
    'corrects through the versioned RPC and reports the receipt rather than an invented replacement',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* fixture()
          const respond = Effect.fn('MemoryToolsTest.respond')(function* () {
            yield* tools.reply(
              'Recall',
              { query: memory.content, limit: 100 },
              Exit.succeed({ memories: [memory] }),
            )
            yield* tools.reply(
              'CorrectMemory',
              { id: memory.id, content: corrected.content },
              Exit.succeed({ memory: corrected }),
            )
          })
          const [result] = yield* Effect.all(
            [tools.correct(memory.content, corrected.content), respond()],
            { concurrency: 2 },
          )
          expect(result).toEqual({
            output: { ok: true, corrected: { was: memory.content, now: corrected.content } },
            terminate: false,
          })
          wordsOnly(result.output)
        }),
      ),
  )

  it.effect(
    'lists every ambiguous candidate and makes no mutation, including identical contents',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* fixture()
          const candidates = [memory, { ...memory, id: MemoryId.make('MARK-second') }, corrected]
          for (const operation of [
            tools.forget(memory.content),
            tools.correct(memory.content, corrected.content),
          ]) {
            const [result] = yield* Effect.all(
              [
                operation,
                tools.reply(
                  'Recall',
                  { query: memory.content, limit: 100 },
                  Exit.succeed({ memories: candidates }),
                ),
              ],
              { concurrency: 2 },
            )
            expect(result.output).toEqual({
              ok: false,
              matches: [memory.content, `${memory.content} (2)`, corrected.content],
              message:
                'No unique exact match was found. Choose one of these memories; nothing has changed.',
            })
            wordsOnly(result.output)
            expect(yield* Queue.size(tools.requests)).toBe(0)
          }
        }),
      ),
  )

  it.effect(
    'reports absence and previews a broad plural request even when recall finds only one',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* fixture()
          const [missing] = yield* Effect.all(
            [
              tools.forget('old address'),
              tools.reply(
                'Recall',
                { query: 'old address', limit: 100 },
                Exit.succeed({ memories: [] }),
              ),
            ],
            { concurrency: 2 },
          )
          expect(missing.output).toEqual({
            ok: false,
            matches: [],
            message: 'No matching memory was found.',
          })
          const [preview] = yield* Effect.all(
            [
              tools.forget('everything about meetings'),
              tools.reply(
                'Recall',
                { query: 'everything about meetings', limit: 100 },
                Exit.succeed({ memories: [memory] }),
              ),
            ],
            { concurrency: 2 },
          )
          expect(preview.output).toMatchObject({ ok: false, matches: [memory.content] })
          wordsOnly(missing.output)
          wordsOnly(preview.output)
          expect(yield* Queue.size(tools.requests)).toBe(0)
        }),
      ),
  )

  it.effect(
    'keeps server ownership refusals and never reports an unauthorized Company edit as success',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* fixture()
          const companyMemory = { ...memory, scope: MemoryScope.cases.Company.make({}) }
          for (const kind of ['forget', 'correct'] as const) {
            const operation =
              kind === 'forget'
                ? tools.forget(memory.content)
                : tools.correct(memory.content, corrected.content)
            const respond = Effect.fn('MemoryToolsTest.respond')(function* () {
              yield* tools.reply(
                'Recall',
                { query: memory.content, limit: 100 },
                Exit.succeed({ memories: [companyMemory] }),
              )
              const tag = kind === 'forget' ? 'ForgetMemory' : 'CorrectMemory'
              const payload: Schema.Json =
                kind === 'forget'
                  ? { id: memory.id }
                  : { id: memory.id, content: corrected.content }
              yield* tools.reply(
                tag,
                payload,
                Exit.fail(NotFound.make({ message: 'Memory not found' })),
              )
            })
            const [result] = yield* Effect.all([operation, respond()], { concurrency: 2 })
            expect(result.output).toEqual({
              ok: false,
              message: 'It does not exist or the person cannot see it.',
            })
            wordsOnly(result.output)
          }
        }),
      ),
  )
})
