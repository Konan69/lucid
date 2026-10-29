import { defineTool } from './tool.ts'
import {
  Tool,
  InvalidRequest,
  TodoState,
  AddTodoRequest,
  CompleteTodoRequest,
  DropTodoRequest,
  type Todo,
} from '@vivid/contracts'
import { Effect, Result } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { named } from './names.ts'
import { instant, localTime } from './owed.ts'
import { Scope, type RunTool } from './scope.ts'
import { modelText } from './views.ts'

const what = text('What the Person means to do, in their own words.', 240)

/** How many closed to-dos the list shows the model, newest first, beside every open one. */
const CLOSED_SHOWN = 10

/** Only words and the confirmed state enter model context; identifiers stay in the RPC client. */
const view = (todo: Todo) => ({
  what: modelText(todo.what),
  due: todo.due,
  state: TodoState.match(todo.state, {
    Open: () => ({ status: 'open' }),
    Done: ({ at }) => ({ status: 'done', at }),
    Dropped: ({ at, why }) => ({ status: 'dropped', at, why: modelText(why) }),
  }),
})

/**
 * An exact `what` resolves only among the Person's open to-dos (`ListTodos` is already scoped to
 * the acting Person). A missing or ambiguous name answers with the open list, so the model asks
 * or picks the exact words; it never closes a guessed record.
 */
const select = Effect.fn('TodoTools.select')(function* (input: { what: string }) {
  const { client } = yield* Scope
  const response = yield* client.ListTodos()
  const open = response.todos.filter((todo) => TodoState.guards.Open(todo.state))
  const selected = named(
    open.map((item) => ({ name: item.what, item })),
    input.what,
  )
  return yield* Result.match(selected, {
    onSuccess: Effect.succeed,
    onFailure: () =>
      Effect.fail(
        new InvalidRequest({
          message: `No single open to-do has those words. Choose the exact words of one of these open to-dos, or ask the Person which they mean: ${JSON.stringify(open.map((todo) => modelText(todo.what)))}`,
        }),
      ),
  })
})

/** The Person's own list. Product persistence and access stay on the server. */
export function todoTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.list_todos,
      description:
        'List the Person’s own to-do list: every open to-do, and the most recently ticked off or dropped.',
      input: v.object({ summary }),
      run({ signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.ListTodos()
            const open = response.todos.filter((todo) => TodoState.guards.Open(todo.state))
            const closed = response.todos.filter((todo) => !TodoState.guards.Open(todo.state))
            return {
              output: {
                open: open.map(view),
                closed: closed.slice(0, CLOSED_SHOWN).map(view),
              },
            }
          }),
          { signal, tool: 'list_todos' },
        )
      },
    }),
    defineTool({
      name: Tool.add_todo,
      description:
        'Add something to the Person’s own to-do list when they ask you to, or when they clearly commit to doing it themselves. Keep their words. Give a due date only when they gave one, resolved with their context clock and time zone; otherwise null. Never invent a date. Work you will do yourself is not a to-do.',
      input: v.strictObject({ summary, what, due: v.nullable(localTime) }),
      /** The current Thread and acting Person come from Scope, never model arguments. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client, acting } = yield* Scope
            const due = data.due === null ? null : yield* instant(data.due)
            const todo = yield* client.AddTodo(
              AddTodoRequest.make({ threadId: acting.threadId, what: data.what, due }),
            )
            return { output: { ok: true, ...view(todo) } }
          }),
          { signal, tool: 'add_todo' },
        )
      },
    }),
    defineTool({
      name: Tool.complete_todo,
      description:
        'Tick off an open to-do by its exact words, only on evidence it was done: the Person says so, or you saw the result. Words that match no single open to-do return the open list to choose from.',
      input: v.strictObject({ summary, what }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const selected = yield* select(data)
            const todo = yield* client.CompleteTodo(CompleteTodoRequest.make({ id: selected.id }))
            return { output: { ok: true, ...view(todo) } }
          }),
          { signal, tool: 'complete_todo' },
        )
      },
    }),
    defineTool({
      name: Tool.drop_todo,
      description:
        'Take an open to-do off the Person’s list when they no longer mean to do it, by its exact words, keeping their reason. Words that match no single open to-do return the open list to choose from.',
      input: v.strictObject({
        summary,
        what,
        why: text('Why the Person no longer means to do it.', 240),
      }),
      /** Dropping keeps the to-do and its reason; it does not delete the Person's history. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const selected = yield* select(data)
            const todo = yield* client.DropTodo(
              DropTodoRequest.make({ id: selected.id, why: data.why }),
            )
            return { output: { ok: true, ...view(todo) } }
          }),
          { signal, tool: 'drop_todo' },
        )
      },
    }),
  ] as const
}
