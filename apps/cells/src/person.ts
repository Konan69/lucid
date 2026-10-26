import type { Wake } from '@earendil-works/pi-durable'
import {
  HarnessWake,
  modelsLayer,
  Persons,
  personsLayer,
  productLayer,
  routes,
  RuntimeSettings,
} from '@vivid/agent-runtime/cell'
import { PersonId } from '@vivid/contracts'
import { ConfigProvider, type Context, Effect, Layer, Option, Redacted, Schema, Scope } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpRouter from 'effect/http/HttpRouter'
import type { CellEnv, CellState } from './cloudflare.ts'
import { meter, type Meter } from './meter.ts'
import { notesLayer } from './notes.ts'
import { skillsLayer } from './skills.ts'
import { storesLayer } from './stores.ts'

/** The cell's variables: the runtime token the server presents, and where the server is. */
const Variables = Schema.Struct({
  VIVID_RUNTIME_TOKEN: Schema.NonEmptyString,
  VIVID_SERVER_URL: Schema.NonEmptyString,
})

/**
 * The runtime's settings for a cell. Only `token`, `serverUrl` and `idleMillis` are read on the
 * cell's path (`app.ts`, `client.ts`, `persons.ts`); the notes directory, database URL, host and
 * port belong to the Node process's own layers (`runtimeNotesLayer`, `storesLayer`, `main.ts`),
 * which a cell does not build, so they name the cell instead.
 */
const settingsOf = (env: CellEnv) =>
  Effect.map(Schema.decodeUnknownEffect(Variables)(env), (variables) =>
    RuntimeSettings.of({
      notesDirectory: 'cell',
      databaseUrl: Redacted.make('cell'),
      token: Redacted.make(variables.VIVID_RUNTIME_TOKEN),
      serverUrl: new URL(variables.VIVID_SERVER_URL),
      idleMillis: 600_000,
      host: 'cell',
      port: 0,
    }),
  )

/**
 * Everything the runtime's `routes` need, for one Person: the runtime's own Persons, Product and
 * Models layers, over the cell's Stores, Notes and skills. Model configuration (`VIVID_MODEL`, the
 * provider key) is read from the cell's variables by the runtime's `modelsLayer`.
 */
const cellLayer = (
  state: CellState,
  env: CellEnv,
  owner: PersonId,
  metered: Meter,
  onWake: (wake: Wake) => void,
) =>
  Layer.unwrap(
    Effect.map(settingsOf(env), (settings) =>
      personsLayer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            productLayer,
            modelsLayer,
            skillsLayer,
            notesLayer(state.storage, owner),
            storesLayer(owner, metered),
          ),
        ),
        Layer.provideMerge(Layer.succeed(RuntimeSettings, settings)),
        Layer.provideMerge(Layer.succeed(HarnessWake, Option.some(onWake))),
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      ),
    ),
  )

/** What the cell holds once open: the routes, and the services the alarm and the routes share. */
interface Opened {
  readonly owner: PersonId
  readonly services: Context.Context<Persons>
  readonly handler: (request: Request) => Promise<Response>
}

/**
 * A recovery heartbeat while work runs, never later than the earliest sleep (Pi README, the
 * `Session` example's `#arm`, 60 s). A cell whose owner node dies with work in flight is woken by
 * this alarm on the node that takes it over (`durable-objects.md`: the waker wakes a cell whose
 * owner stopped), and opening it resumes the work, with no client request.
 */
const HEARTBEAT_MS = 60_000

/**
 * One Person's conversations as a celld Durable Object (docs/27-runtime-cells.md).
 *
 * The constructor opens everything inside `blockConcurrencyWhile`, so no request reaches the
 * routes before the Harness is open, as Pi's Cloudflare guidance has it. It first arms a fallback
 * alarm, so a cell whose open fails is started again. Opening builds the runtime's Persons layer
 * (which resumes any reply a previous owner left unfinished) and then holds the Person once, which
 * opens the Harness and leaves it open for the idle bound. The Harness reports through `onWake`
 * whether work is active; the alarm follows it. The times are logged as one JSON line so the
 * proof driver can read them from the node's log.
 */
export class Person {
  private readonly metered: Meter
  private readonly ready: Promise<Opened>

  constructor(
    private readonly state: CellState,
    env: CellEnv,
  ) {
    this.metered = meter(state.storage)
    this.ready = state.blockConcurrencyWhile(() => this.open(state, env))
  }

  /** Arm or clear the alarm for what the Harness says it needs. */
  // @effect-diagnostics-next-line asyncFunction:off -- Durable Object storage is a Promise API; this is the framework boundary.
  private async arm(wake: Wake) {
    const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined
    const at =
      heartbeat === undefined || wake.at === undefined
        ? (heartbeat ?? wake.at)
        : Math.min(heartbeat, wake.at)
    if (at === undefined) await this.state.storage.deleteAlarm()
    else await this.state.storage.setAlarm(at)
    console.log(JSON.stringify({ event: 'arm', active: wake.active, at: at ?? null }))
  }

  // @effect-diagnostics-next-line asyncFunction:off -- Durable Object and Worker handlers are Promise APIs; this is the framework boundary.
  private async open(state: CellState, env: CellEnv): Promise<Opened> {
    const started = Date.now()
    // `idFromName` keeps the name (`durable-objects.md`); a cell reached any other way has no Person.
    const name = state.id.name
    if (name === undefined) throw new Error('A Person cell must be addressed by the Person id')
    const owner = PersonId.make(name)
    // A fallback before anything can throw: a cell whose open or recovery fails is started again.
    const fallback = Date.now() + HEARTBEAT_MS
    const current = await state.storage.getAlarm()
    if (current === null || current > fallback) await state.storage.setAlarm(fallback)
    // Pi calls this off its Session line after a commit and it must not block; a failed alarm
    // write is logged, and the value is offered again at the next change.
    const onWake = (wake: Wake) => {
      this.arm(wake).catch((error: unknown) =>
        console.log(JSON.stringify({ event: 'arm_failed', error: String(error) })),
      )
    }
    const scope = Scope.makeUnsafe()
    try {
      const services = await Effect.runPromise(
        Layer.buildWithScope(cellLayer(state, env, owner, this.metered, onWake), scope),
      )
      const built = Date.now()
      const wake = await Effect.runPromise(
        Effect.gen(function* () {
          const persons = yield* Persons
          return yield* persons.use(owner, ({ harness }) => Effect.sync(() => harness.wake()))
        }).pipe(Effect.provide(services)),
      )
      await this.arm(wake)
      const opened = Date.now()
      console.log(
        JSON.stringify({
          event: 'person_open',
          person: owner,
          buildMs: built - started,
          holdMs: opened - built,
          totalMs: opened - started,
          active: wake.active,
        }),
      )
      // The route handlers' own requirements are request requirements in Effect 4's router, so the
      // services go to each call as its context, not only to the routes' Layer.
      const { handler } = HttpRouter.toWebHandler(
        routes.pipe(Layer.provide(Layer.succeedContext(services))),
      )
      return { owner, services, handler: (request: Request) => handler(request, services) }
    } catch (error) {
      console.log(
        JSON.stringify({
          event: 'person_open_failed',
          person: owner,
          ms: Date.now() - started,
          error: String(error),
        }),
      )
      throw error
    }
  }

  /**
   * The alarm: keep the heartbeat while work may run, then resume (Pi README, `alarm()` in the
   * `Session` example). Opening the cell already resumed what a lost owner left; `resume()` here
   * also covers a live cell whose sleep came due.
   */
  // @effect-diagnostics-next-line asyncFunction:off -- Durable Object handlers are Promise APIs; this is the framework boundary.
  async alarm(): Promise<void> {
    const { owner, services } = await this.ready
    const wake = await Effect.runPromise(
      Effect.gen(function* () {
        const persons = yield* Persons
        return yield* persons.use(owner, ({ harness }) =>
          Effect.sync(() => {
            const now = harness.wake()
            harness.resume()
            return now
          }),
        )
      }).pipe(Effect.provide(services)),
    )
    console.log(JSON.stringify({ event: 'alarm', person: owner, active: wake.active }))
    await this.arm({ ...wake, active: true })
  }

  // @effect-diagnostics-next-line asyncFunction:off -- Durable Object and Worker handlers are Promise APIs; this is the framework boundary.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // Proof instrumentation (`meter.ts`): the driver reads and resets the commit numbers here.
    if (url.pathname.endsWith('/__meter')) {
      const snapshot = this.metered.snapshot()
      if (url.searchParams.has('reset')) this.metered.reset()
      return Response.json(snapshot)
    }
    // Proof instrumentation: one read-only SELECT on the cell's SQLite, to inspect Pi's rows.
    if (url.pathname.endsWith('/__select')) {
      await this.ready
      const query = url.searchParams.get('q') ?? ''
      if (!/^\s*select\b/iu.test(query)) return new Response('select only', { status: 400 })
      return Response.json(this.state.storage.sql.exec(query).toArray())
    }
    const { handler } = await this.ready
    // Arm before any call that can start work (Pi README: `onWake` runs after the commit, and a
    // missing alarm strands the work; an early one is harmless).
    if (request.method === 'POST') await this.arm({ active: true })
    const response = await handler(request)
    if (response.status >= 500)
      console.log(
        JSON.stringify({ event: 'route_failed', path: url.pathname, status: response.status }),
      )
    return response
  }
}
