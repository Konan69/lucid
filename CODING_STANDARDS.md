# Coding standards

`AGENTS.md` is authoritative. The vendored `coding-standards`, `effect`, and `effect-service-design` skills provide the detailed guidance; this file is the short review index for Vivid's pinned Effect `4.0.0-rc.116` code.

## Model boundaries first

Define a schema-backed domain value before orchestration. Decode unknown input once at its real boundary. Branded identifiers prevent mixing identities; tagged variants replace optional bags and boolean state machines.

```ts
import * as Schema from 'effect/Schema'

export const ThreadId = Schema.String.pipe(Schema.brand('ThreadId'))
export type ThreadId = typeof ThreadId.Type

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()('ThreadNotFound', {
  threadId: ThreadId,
}) {}
```

Do not replace the contract with a cast:

```ts
// Bad: invents evidence instead of parsing it.
const threadId = request.params.id as ThreadId
```

Effect Schema decoder, encoder, predicate, and assertion factories compile work. When the schema is a module-level value, compile the adapter once beside it rather than rebuilding it inside a function. A genuinely dynamic schema parameter stays in its owning factory.

```ts
const decodeThread = Schema.decodeUnknownEffect(Thread)

const handleThread = (input: unknown) => decodeThread(input)
```

## Close domain states

Use `Schema.TaggedUnion` when the variants are a closed set. Its generated cases, guards, subset predicates, and matcher keep construction and branching derived from one declaration.

```ts
const RunState = Schema.TaggedUnion({
  Queued: { runId: RunId },
  Working: { runId: RunId, startedAt: Schema.DateTimeUtc },
  Failed: { runId: RunId, reason: Schema.String },
})

const queued = RunState.cases.Queued.make({ runId })
const isActive = RunState.isAnyOf(['Queued', 'Working'])
const label = RunState.match({
  Queued: () => 'Queued',
  Working: () => 'Working',
  Failed: () => 'Failed',
})
```

Do not rebuild the same state with optional fields and ad hoc comparisons:

```ts
// Bad: invalid combinations compile and every consumer re-invents readiness.
type RunState = {
  status: string
  startedAt?: Date
  reason?: string
}
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

Different recovery paths require different error tags, not one stringly catch-all:

```ts
// Bad: callers must parse a free-form code to decide what to do.
class OperationFailed extends Schema.TaggedError<OperationFailed>()('OperationFailed', {
  code: Schema.String,
  message: Schema.String,
}) {}

// Good: handling is exhaustive and carries the identity that failed.
class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()('ThreadNotFound', {
  threadId: ThreadId,
}) {}
class ThreadAccessDenied extends Schema.TaggedError<ThreadAccessDenied>()('ThreadAccessDenied', {
  threadId: ThreadId,
  personId: PersonId,
}) {}
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

## Construct explicit boundaries

Do not hide shape changes behind conditional spreads or fallback values.

```ts
// Bad: silently omits tenancy and invents an empty title.
const thread = {
  id,
  title: input.title ?? '',
  ...(input.companyId ? { companyId: input.companyId } : {}),
}

// Good: the variant states exactly which boundary value is being built.
const thread =
  input._tag === 'CompanyThread'
    ? CompanyThread.make({ id, companyId: input.companyId, title: input.title })
    : PersonalThread.make({ id, personId: input.personId, title: input.title })
```

## Validate both sides of HTTP

`response.json()` and `request<T>()` are unknown input. Producer and consumer use the same schema from `packages/contracts`.

```ts
// Bad: a generic annotation cannot prove the payload.
const thread = await request<Thread>(`/api/threads/${id}`)

// Good: trust begins at the shared parser.
const payload = yield * Effect.tryPromise(() => response.json())
const thread = yield * Schema.decodeUnknownEffect(ThreadResponse)(payload)
```

## Configuration and secrets

Follow `apps/server/src/config.ts`: load environment through `Config.schema`, convert expected startup failures into `ConfigurationError`, and keep database URLs, auth secrets, and provider secrets in `Redacted` values. Log the variable name and expected form, never the supplied value.

## Drizzle

Drizzle TypeScript schemas are authoritative. Change the schema, run the package's `db:generate`, review the SQL, then migrate. Never hand-edit schema migrations or snapshots. Keep database-driver failures behind a service boundary like `apps/server/src/database.ts`, where SQL failures become `DatabaseUnavailable`, `DatabaseConstraintViolation`, or `DatabaseFailure`.

## React owns events, not synchronization effects

Prefer derived values, loaders, query primitives, subscriptions, and event handlers on web and mobile. `useLayoutEffect` is only for preventing a visibly wrong frame.

```tsx
// Bad: derived state adds a stale render and synchronization loop.
const [fullName, setFullName] = useState('')
useEffect(() => setFullName(`${first} ${last}`), [first, last])

// Good: derive during render.
const fullName = `${first} ${last}`
```

## Toolchain contract

`pnpm check:package-manager` rejects package-manager drift and foreign lockfiles. `pnpm check:versions` enforces the native TypeScript preview, strict Effect language-service diagnostics, and exact Effect/Alchemy/Better Auth/Drizzle lockstep. `pnpm lint` always runs Oxlint with native type-aware analysis, including web design-system contracts and Tailwind correctness. `pnpm audit:effect-boundaries` rejects new raw async, Promise, fetch, and Effect runtime seams unless their exact file and owning symbol are classified. `pnpm check:migrations` validates generated SQL and snapshot chains without editing them.

Import Node built-ins as canonical namespaces such as `import * as NodePath from 'node:path'`; the lint rule owns acronym aliases such as `NodeFS`, `NodeFSP`, `NodeOS`, and `NodeURL`. Cross package boundaries through `@vivid/client-runtime` and `@vivid/contracts`, never deep relative paths.

Vitest runs app and package `.test.ts`/`.test.tsx` suites. Effect tests use `@effect/vitest` `it.effect(...)` and test Layers instead of `Effect.runPromise`, `Effect.runSync`, or `Effect.runFork`. Tooling suites under `scripts/*.test.mjs` remain on `node --test`.

## Review checklist

1. Does every ingress parse into a named domain type?
2. Are closed states and expected failures precise, tagged, and exhaustive?
3. Does each service own a real capability rather than rename a function?
4. Are Layers composed at the owning boundary without hidden dependencies?
5. Do HTTP consumers validate the shared wire schema, and do tests prove behavior through public seams?
