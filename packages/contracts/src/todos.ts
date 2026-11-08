import * as Schema from 'effect/Schema'
import { PersonId, ThreadId, TodoId } from './identity.js'

/**
 * The Person's own to-do list: things the Person means to do, which Vivid adds to when they ask
 * or clearly commit to something, and ticks off when there is evidence it was done
 * ([docs/23](../../../docs/23-product-definition.md) "Still open" 3). It is the Person's list,
 * not Vivid's work: what Vivid itself owes is a Run, and what someone owes the Person is `Owed`
 * (`owed.ts`), whose shape and lifecycle this one follows.
 *
 * A to-do belongs to one Person and names the Thread it was added in, so the Feed row opens the
 * conversation it came from. Company scope stays in the server's owned row, as it does for `Owed`.
 */

/** What to do, in the Person's words: "renew my passport", "call the plumber about the boiler". */
const What = Schema.NonEmptyString.check(Schema.isMaxLength(240))
/** Why the Person stopped meaning to do it, in their words or where they decided it. */
const Why = Schema.NonEmptyString.check(Schema.isMaxLength(240))

/**
 * Where a to-do stands. `Done` and `Dropped` are terminal and keep when they happened; a drop
 * keeps why, so the same thing is not quietly added again.
 */
export const TodoState = Schema.TaggedUnion({
  /** Still to do. */
  Open: {},
  /** Ticked off: by the Person on the Feed, or by Vivid on evidence it was done. */
  Done: { at: Schema.Finite },
  /** The Person no longer means to do it. */
  Dropped: { at: Schema.Finite, why: Why },
})
export type TodoState = typeof TodoState.Type

export class Todo extends Schema.Class<Todo>('Todo')(
  {
    id: TodoId,
    /** The Person whose list it is. Attribution, never tenancy. */
    personId: PersonId,
    /** The Thread it was added in. The Feed row opens it. */
    threadId: ThreadId,
    what: What,
    /** When it should be done by, when the Person gave a date. Absent is a real state: no date. */
    due: Schema.NullOr(Schema.Finite),
    state: TodoState,
    updatedAt: Schema.Finite,
  },
  { title: 'Todo' },
) {}

/** Vivid adds something to the Person's list, from the Thread it is working in. */
export class AddTodoRequest extends Schema.Class<AddTodoRequest>('AddTodoRequest')(
  { threadId: ThreadId, what: What, due: Schema.NullOr(Schema.Finite) },
  { title: 'Add todo request' },
) {}

/** Ticks a to-do off. Ticking off one already done answers with it as it was. */
export class CompleteTodoRequest extends Schema.Class<CompleteTodoRequest>('CompleteTodoRequest')(
  { id: TodoId },
  { title: 'Complete todo request' },
) {}

export class DropTodoRequest extends Schema.Class<DropTodoRequest>('DropTodoRequest')(
  { id: TodoId, why: Why },
  { title: 'Drop todo request' },
) {}

/** Open first, soonest due first and undated last; done and dropped after, newest first. */
export class TodoListResponse extends Schema.Class<TodoListResponse>('TodoListResponse')(
  { todos: Schema.Array(Todo) },
  { title: 'Todo list response' },
) {}
