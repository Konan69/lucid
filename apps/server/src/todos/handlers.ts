import { Effect } from 'effect'
import {
  TodoListResponse,
  type AddTodoRequest,
  type CompleteTodoRequest,
  type DropTodoRequest,
} from '@vivid/contracts'
import { requireActor, type Actor } from '../auth/access.ts'
import { live } from '../live/query.ts'
import { TodoStore } from './store.ts'

/** List and Watch load exactly the same owner-scoped projection. */
const todos = Effect.fn('Todos.list')(function* (actor: Actor) {
  return TodoListResponse.make({ todos: yield* (yield* TodoStore).list(actor) })
})

/** RpcServer decodes requests and encodes replies using the shared contracts. */
export const todoHandlers = {
  ListTodos: Effect.fn('Rpc.ListTodos')(function* () {
    return yield* todos(yield* requireActor())
  }),
  WatchTodos: () => live('WatchTodos', [], todos),
  AddTodo: Effect.fn('Rpc.AddTodo')(function* (request: AddTodoRequest) {
    return yield* (yield* TodoStore).add(yield* requireActor(), request)
  }),
  CompleteTodo: Effect.fn('Rpc.CompleteTodo')(function* (request: CompleteTodoRequest) {
    return yield* (yield* TodoStore).complete(yield* requireActor(), request)
  }),
  DropTodo: Effect.fn('Rpc.DropTodo')(function* (request: DropTodoRequest) {
    return yield* (yield* TodoStore).drop(yield* requireActor(), request)
  }),
}
