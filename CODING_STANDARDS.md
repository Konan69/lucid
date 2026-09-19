# Coding standards

`AGENTS.md` is authoritative. The vendored `coding-standards`, `effect`, and `effect-service-design` skills provide the detailed guidance; this file is the short review index for Vivid's Effect 4 code.

## Model boundaries first

Define a schema-backed domain value before orchestration. Decode unknown input once at its real boundary. Branded identifiers prevent mixing identities; tagged variants replace optional bags and boolean state machines.

```ts
import * as Schema from 'effect/Schema'

export const ThreadId = Schema.String.pipe(Schema.brand('ThreadId'))
export type ThreadId = typeof ThreadId.Type

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()(
  'ThreadNotFound',
  { threadId: ThreadId },
) {}
```

Do not replace the contract with a cast:

```ts
// Bad: invents evidence instead of parsing it.
const threadId = request.params.id as ThreadId
```

## Keep failures typed

Application and domain code returns expected failures through Effect. Translate Promise rejection or thrown third-party failures once in the adapter that owns them.

```ts
const loadThread = Effect.fn('Threads.load')(function* (id: ThreadId) {
  const threads = yield* Threads
  return yield* threads.get(id)
})
```

Do not use `try/catch`, `Effect.orDie`, or an untyped raw Promise to hide a normal failure:

```ts
// Bad: callers cannot see or handle the storage failure.
async function loadThread(id: string) {
  try {
    return await database.get(id)
  } catch {
    return null
  }
}
```

## Services own capabilities

A `Context.Service` represents an authority seam such as persistence, configuration, time, or an external provider. The implementation Layer acquires dependencies once and closes over them. Plain inputs and pure transformations remain values.

```ts
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

interface ThreadStoreShape {
  readonly get: (id: ThreadId) => Effect.Effect<Thread, ThreadNotFound | DatabaseFailure>
}

export class ThreadStore extends Context.Service<ThreadStore, ThreadStoreShape>()(
  'vivid/ThreadStore',
) {}

export const threadStoreLayer = Layer.effect(
  ThreadStore,
  Effect.gen(function* () {
    const database = yield* Database
    return ThreadStore.of({
      get: Effect.fn('ThreadStore.get')(function* (id) {
        return yield* database.getThread(id)
      }),
    })
  }),
)
```

Call methods through their owner (`database.getThread(id)`). Do not destructure a method and lose its receiver.

## Configuration and secrets

Follow `apps/server/src/config.ts`: load environment through `Config.schema`, convert expected startup failures into `ConfigurationError`, and keep database URLs, auth secrets, and provider secrets in `Redacted` values. Log the variable name and expected form, never the supplied value.

## Drizzle

Drizzle TypeScript schemas are authoritative. Change the schema, run the package's `db:generate`, review the SQL, then migrate. Never hand-edit schema migrations or snapshots. Keep database-driver failures behind a service boundary like `apps/server/src/database.ts`, where SQL failures become `DatabaseUnavailable`, `DatabaseConstraintViolation`, or `DatabaseFailure`.

## Review checklist

1. Does every ingress parse into a named domain type?
2. Are expected failures precise and typed?
3. Does each service own a real capability rather than rename a function?
4. Are Layers composed at the owning boundary without hidden dependencies?
5. Do tests prove behavior through the public seam rather than implementation details?
