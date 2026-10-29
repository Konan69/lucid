import { and, desc, eq, sql } from 'drizzle-orm'
import { Clock, Context, Effect, Layer } from 'effect'
import {
  Conflict,
  NotFound,
  Todo,
  TodoId,
  TodoState,
  type AddTodoRequest,
  type CompleteTodoRequest,
  type DropTodoRequest,
} from '@vivid/contracts'
import { companyColumnOf, ownedHere, type Actor } from '../auth/access.ts'
import { Database, decodeStored, encodeStored, returned } from '../database/client.ts'
import { changed } from '../live/changes.ts'
import { requireThread } from '../threads/access.ts'
import { todos } from './tables.ts'

const decodeTodo = decodeStored(Todo, 'to-do')
const encodeState = encodeStored(TodoState, 'to-do state')

/**
 * How a closing request moves an open to-do, and what it says about one already closed: the same
 * closing again is answered with the record as it stands, so a retried tick-off or a second
 * device's press neither fails nor moves the time it was done; any other closing is a Conflict.
 */
interface Closing {
  readonly again: (state: TodoState) => boolean
  readonly next: (at: number) => TodoState
}

/** The Person owns the list even in a Company. Terminal to-dos keep when and why they closed. */
const makeStore = (database: Database['Service']) => {
  /** Open to-dos come first by date, undated last; closed ones follow by most recent change. */
  const list = Effect.fn('TodoStore.list')(function* (actor: Actor) {
    const open = sql`${todos.state}->>'_tag' = 'Open'`
    const rows = yield* database.run(
      database
        .select()
        .from(todos)
        .where(ownedHere(todos, actor))
        .orderBy(
          sql`case when ${open} then 0 else 1 end`,
          sql`case when ${open} then ${todos.due} end asc nulls last`,
          desc(todos.updatedAt),
        ),
    )
    return yield* Effect.forEach(rows, decodeTodo)
  })

  /**
   * Thread access and workspace agree before the to-do joins the calling Person's list. The same
   * words already open on the list (case and outer spaces aside) answer with that to-do instead of
   * a second one: two identical open to-dos cannot be told apart by words, so "I renewed it" could
   * tick off neither (verify-vivid, 29 October 2026). Adds for one owner serialize on an advisory
   * lock, as Skill names do (`skills/store.ts` `lockScope`), so two at once cannot both insert.
   */
  const add = Effect.fn('TodoStore.add')(function* (actor: Actor, request: AddTodoRequest) {
    const thread = yield* requireThread(request.threadId, actor.person.id)
    const companyId = companyColumnOf(actor.workspace)
    if (thread.companyId !== companyId) return yield* new NotFound({ message: 'Thread not found' })
    const state = yield* encodeState(TodoState.cases.Open.make({}))
    const outcome = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const key =
          companyId === null
            ? `todos:person:${actor.person.id}`
            : `todos:company:${companyId}:${actor.person.id}`
        yield* tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
        const same = yield* tx
          .select()
          .from(todos)
          .where(
            and(
              ownedHere(todos, actor),
              sql`${todos.state}->>'_tag' = 'Open'`,
              sql`lower(btrim(${todos.what})) = lower(btrim(${request.what}))`,
            ),
          )
          .limit(1)
        const existing = same[0]
        if (existing !== undefined) return { todo: yield* decodeTodo(existing), added: false }
        const rows = yield* tx
          .insert(todos)
          .values({
            id: TodoId.make(crypto.randomUUID()),
            personId: actor.person.id,
            companyId,
            threadId: request.threadId,
            what: request.what,
            due: request.due,
            state,
            updatedAt: yield* Clock.currentTimeMillis,
          })
          .returning()
        return { todo: yield* decodeTodo(yield* returned(rows, 'to-do')), added: true }
      }),
    )
    if (outcome.added) yield* changed(actor)
    return outcome.todo
  })

  /**
   * Lock the scoped row, so two racing tick-offs serialize: the first closes it, the second reads
   * it closed and is answered by `closing.again`. A closed to-do never reopens.
   */
  const close = Effect.fn('TodoStore.close')(function* (
    actor: Actor,
    id: TodoId,
    closing: Closing,
  ) {
    const outcome = yield* database.transaction((tx) =>
      Effect.gen(function* () {
        const condition = and(eq(todos.id, id), ownedHere(todos, actor))
        const rows = yield* tx.select().from(todos).where(condition).for('update')
        const row = rows[0]
        if (row === undefined) return yield* new NotFound({ message: 'To-do not found' })
        const before = yield* decodeTodo(row)
        if (closing.again(before.state)) return { todo: before, moved: false }
        if (!TodoState.guards.Open(before.state))
          return yield* new Conflict({ message: 'This to-do is already closed' })
        const now = yield* Clock.currentTimeMillis
        const state = yield* encodeState(closing.next(now))
        const updated = yield* tx
          .update(todos)
          .set({ state, updatedAt: now })
          .where(condition)
          .returning()
        return { todo: yield* decodeTodo(yield* returned(updated, 'to-do')), moved: true }
      }),
    )
    if (outcome.moved) yield* changed(actor)
    return outcome.todo
  })

  /** Ticking off is idempotent: a to-do already done is answered as it was. */
  const complete = Effect.fn('TodoStore.complete')(function* (
    actor: Actor,
    request: CompleteTodoRequest,
  ) {
    return yield* close(actor, request.id, {
      again: TodoState.guards.Done,
      next: (at) => TodoState.cases.Done.make({ at }),
    })
  })

  /** Dropping keeps the reason. A to-do already closed, either way, is a Conflict. */
  const drop = Effect.fn('TodoStore.drop')(function* (actor: Actor, request: DropTodoRequest) {
    return yield* close(actor, request.id, {
      again: () => false,
      next: (at) => TodoState.cases.Dropped.make({ at, why: request.why }),
    })
  })
  return { list, add, complete, drop }
}

export class TodoStore extends Context.Service<TodoStore, ReturnType<typeof makeStore>>()(
  'vivid/TodoStore',
) {}

/** PostgreSQL owns to-dos; live notices use the calling operation's Changes service. */
export const todoStoreLayer = Layer.effect(
  TodoStore,
  Effect.gen(function* () {
    return TodoStore.of(makeStore(yield* Database))
  }),
)
