import {
  modelsLayer,
  Persons,
  personsLayer,
  productLayer,
  routes,
  RuntimeSettings,
} from '@vivid/agent-runtime/cell'
import { PersonId } from '@vivid/contracts'
import { ConfigProvider, Effect, Layer, Redacted, Schema, Scope } from 'effect'
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
const cellLayer = (state: CellState, env: CellEnv, owner: PersonId, metered: Meter) =>
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
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      ),
    ),
  )

/**
 * One Person's conversations as a celld Durable Object (docs/27-runtime-cells.md).
 *
 * The constructor opens everything inside `blockConcurrencyWhile`, so no request reaches the
 * routes before the Harness is open, as Pi's Cloudflare guidance has it. Opening builds the
 * runtime's Persons layer (which resumes any reply a previous owner left unfinished) and then
 * holds the Person once, which opens the Harness and leaves it open for the idle bound. The times
 * are logged as one JSON line so the proof driver can read them from the node's log.
 */
export class Person {
  private readonly metered: Meter
  private readonly ready: Promise<(request: Request) => Promise<Response>>

  constructor(state: CellState, env: CellEnv) {
    this.metered = meter(state.storage)
    this.ready = state.blockConcurrencyWhile(() => this.open(state, env))
  }

  private async open(state: CellState, env: CellEnv) {
    const started = Date.now()
    // `idFromName` keeps the name (`durable-objects.md`); a cell reached any other way has no Person.
    const name = state.id.name
    if (name === undefined) throw new Error('A Person cell must be addressed by the Person id')
    const owner = PersonId.make(name)
    const scope = Scope.makeUnsafe()
    try {
      const services = await Effect.runPromise(
        Layer.buildWithScope(cellLayer(state, env, owner, this.metered), scope),
      )
      const built = Date.now()
      await Effect.runPromise(
        Effect.gen(function* () {
          const persons = yield* Persons
          yield* persons.use(owner, () => Effect.void)
        }).pipe(Effect.provide(services)),
      )
      const opened = Date.now()
      console.log(
        JSON.stringify({ event: 'person_open', person: owner, buildMs: built - started, holdMs: opened - built, totalMs: opened - started }),
      )
      // The route handlers' own requirements are request requirements in Effect 4's router, so the
      // services go to each call as its context, not only to the routes' Layer.
      const { handler } = HttpRouter.toWebHandler(
        routes.pipe(Layer.provide(Layer.succeedContext(services))),
      )
      return (request: Request) => handler(request, services)
    } catch (error) {
      console.log(JSON.stringify({ event: 'person_open_failed', person: owner, ms: Date.now() - started, error: String(error) }))
      throw error
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // Proof instrumentation (`meter.ts`): the driver reads and resets the commit numbers here.
    if (url.pathname.endsWith('/__meter')) {
      const snapshot = this.metered.snapshot()
      if (url.searchParams.has('reset')) this.metered.reset()
      return Response.json(snapshot)
    }
    const handler = await this.ready
    const response = await handler(request)
    if (response.status >= 500)
      console.log(JSON.stringify({ event: 'route_failed', path: url.pathname, status: response.status }))
    return response
  }
}

