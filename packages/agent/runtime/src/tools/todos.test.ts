import { describe, expect, it } from '@effect/vitest'
import { PersonId, ThreadId, Todo, TodoId, TodoListResponse, TodoState } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Layer, Predicate, Queue, Struct } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { todoTools } from './todos.ts'
import { invoke } from './tests/harness.ts'
import { Scope, toolRunner } from './scope.ts'

/** The generated RPC client and real tool runner; responses are deliberate transport fixtures. */
const fixture = Effect.fn('TodoToolsTest.fixture')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
  })
  const personId = PersonId.make('fixture-person')
  const threadId = ThreadId.make('fixture-thread')
  const scope = Layer.succeed(
    Scope,
    Scope.of({ acting: { personId, threadId }, client: rpc.client, timezone: 'Africa/Lagos' }),
  )
  const [, add, complete] = todoTools(toolRunner(scope))
  const context = { signal: yield* Effect.abortSignal }
  const todo = Todo.make({
    id: TodoId.make('fixture-todo'),
    personId,
    threadId,
    what: 'renew my passport',
    due: Date.parse('2026-11-02T08:00:00Z'),
    state: TodoState.cases.Open.make({}),
    updatedAt: 100,
  })
  return { requests, rpc, add, complete, context, todo }
})

/** SDK wire Exit has no constructor. The test replies at the real client's transport boundary. */
const answer = Effect.fn('TodoToolsTest.answer')(function* (
  test: Effect.Success<ReturnType<typeof fixture>>,
  tag: string,
  output: Todo | TodoListResponse,
) {
  const request = yield* Queue.take(test.requests)
  if (!Predicate.isTagged(request, 'Request'))
    return yield* Effect.sync(() => expect.fail('Expected an RPC request'))
  expect(request.tag).toBe(tag)
  yield* test.rpc.write({
    // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK wire envelope has no constructor.
    _tag: 'Exit',
    clientId: 0,
    requestId: request.id,
    exit: Exit.succeed(output),
  })
  return request.payload
})

/** The model supplies words; the tools supply Thread authority, a zoned date and the resolved id. */
describe('To-do tools', () => {
  it.effect(
    'adds in the acting Thread, ticks off by words, and answers ambiguity with choices',
    () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const added = yield* Effect.promise(() =>
          Promise.resolve(
            invoke(test.add, {
              ...test.context,
              data: {
                summary: 'Add the passport',
                what: test.todo.what,
                due: '2026-11-02T09:00:00',
              },
            }),
          ),
        ).pipe(Effect.forkScoped)
        expect(yield* answer(test, 'AddTodo', test.todo)).toEqual({
          threadId: test.todo.threadId,
          what: test.todo.what,
          due: Date.parse('2026-11-02T08:00:00Z'),
        })
        expect(yield* Fiber.join(added)).toMatchObject({
          output: { ok: true, what: test.todo.what, state: { status: 'open' } },
        })

        const done = Todo.make(
          Struct.assign(test.todo, { state: TodoState.cases.Done.make({ at: 200 }) }),
        )
        const ticked = yield* Effect.promise(() =>
          Promise.resolve(
            invoke(test.complete, {
              ...test.context,
              data: { summary: 'Tick off the passport', what: ' Renew my PASSPORT ' },
            }),
          ),
        ).pipe(Effect.forkScoped)
        yield* answer(test, 'ListTodos', TodoListResponse.make({ todos: [test.todo] }))
        expect(yield* answer(test, 'CompleteTodo', done)).toEqual({ id: test.todo.id })
        expect(yield* Fiber.join(ticked)).toMatchObject({
          output: { ok: true, state: { status: 'done', at: 200 } },
        })

        const ambiguous = yield* Effect.promise(() =>
          Promise.resolve(
            invoke(test.complete, {
              ...test.context,
              data: { summary: 'Tick off the passport', what: test.todo.what },
            }),
          ),
        ).pipe(Effect.forkScoped)
        yield* answer(
          test,
          'ListTodos',
          TodoListResponse.make({
            todos: [test.todo, Todo.make(Struct.assign(test.todo, { id: TodoId.make('twin') }))],
          }),
        )
        expect(yield* Fiber.join(ambiguous)).toMatchObject({
          output: { ok: false, message: expect.stringContaining('renew my passport') },
        })
      }).pipe(Effect.scoped),
  )
})
