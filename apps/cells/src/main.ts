import { DurableObject } from 'cloudflare:workers'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { DurableObjectSqliteDatabase } from '@earendil-works/chord/sqlite/cloudflare'
import type { DurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import type { Wake } from '@earendil-works/pi-durable'
import { isAuthorized, openCell } from '@vivid/agent-runtime/cell'
import {
  Memory,
  MemoryUnavailable,
  openMemory,
  MemoryReadResult,
  MemoryWriteResult,
  MemoryDeleteResult,
  MemorySearchResult,
} from '@vivid/agent-runtime/memory'
import {
  PersonId,
  MemoryAddress,
  MemoryIndex,
  MemoryWrite,
  MemoryRetraction,
  MemoryListing,
  MemoryPage,
  MemorySearch,
} from '@vivid/contracts'
import memoryMigration from './memory/migrations/20261028123228_memory/migration.sql'
import searchMigration from './memory/migrations/20261028123228_memory-search/migration.sql'
import { Config, ConfigProvider, Effect, Option, Schema } from 'effect'
import { skills } from './skills.ts'

/** Only the native celld capabilities this host uses, matching celld 0.6.2 DurableObjectState. */
interface CellState {
  readonly id: { readonly name?: string }
  readonly storage: DurableObjectSqliteStorage & {
    getAlarm(): Promise<number | null>
    setAlarm(at: number): Promise<void>
    deleteAlarm(): Promise<void>
  }
  blockConcurrencyWhile<A>(body: () => Promise<A>): Promise<A>
  waitUntil(promise: Promise<unknown>): void
  abort(reason: string): never
}

/** Native stubs carry only this cell's local memory. No method accepts another Person's id. */
interface PersonStub {
  fetch(request: Request): Promise<Response>
  memoryIndex(): Promise<MemoryIndex>
  listMemory(listing: MemoryListing): Promise<MemoryPage>
  searchMemory(search: MemorySearch): Promise<typeof MemorySearchResult.Encoded>
  readMemory(address: MemoryAddress): Promise<typeof MemoryReadResult.Encoded>
  writeMemory(write: MemoryWrite): Promise<typeof MemoryWriteResult.Encoded>
  deleteMemory(retraction: MemoryRetraction): Promise<typeof MemoryDeleteResult.Encoded>
}
interface Environment {
  readonly PERSONS: { getByName(person: PersonId): PersonStub }
  readonly VIVID_RUNTIME_TOKEN: string
  readonly VIVID_SERVER_URL: string
}

/**
 * Pi 1.4's documented host heartbeat protects work lost between a commit and onWake. It is
 * armed before opening or admitting work; native wake deadlines may bring the alarm earlier.
 */
const HEARTBEAT = 60_000
const decodePerson = Schema.decodeUnknownEffect(PersonId)
const decodeListing = Schema.decodeUnknownEffect(MemoryListing)
const decodeSearch = Schema.decodeUnknownEffect(MemorySearch)
const decodeAddress = Schema.decodeUnknownEffect(MemoryAddress)
const decodeWrite = Schema.decodeUnknownEffect(MemoryWrite)
const decodeRetraction = Schema.decodeUnknownEffect(MemoryRetraction)
const encodeRead = Schema.encodeEffect(MemoryReadResult)
const encodeWrite = Schema.encodeEffect(MemoryWriteResult)
const encodeRetraction = Schema.encodeEffect(MemoryDeleteResult)
const encodeSearch = Schema.encodeEffect(MemorySearchResult)
const personOption = Schema.decodeUnknownOption(PersonId)
/** One celld cell owns all Threads created by one Person, their Harness, and their memory. */
export class Person extends DurableObject<CellState, Environment> {
  readonly #state: CellState
  readonly #ready: Promise<{
    readonly runtime: Awaited<ReturnType<typeof openCell>>
    readonly memory: Effect.Success<ReturnType<typeof openMemory>>
  }>

  constructor(state: CellState, environment: Environment) {
    super(state, environment)
    this.#state = state
    this.#ready = state.blockConcurrencyWhile(() => this.#open(environment))
  }

  /** Opening uses only local SQLite and configuration. Recovery starts after the alarm is armed. */
  // @effect-diagnostics-next-line asyncFunction:off -- celld invokes this native host adapter through its Promise API.
  async #open(environment: Environment) {
    const fallback = Date.now() + HEARTBEAT
    const current = await this.#state.storage.getAlarm()
    if (current === null || current > fallback) await this.#state.storage.setAlarm(fallback)
    const personId = await Effect.runPromise(decodePerson(this.#state.id.name))
    const memory = await Effect.runPromise(
      openMemory(new DurableObjectSqliteDatabase(this.#state.storage), [
        memoryMigration,
        searchMigration,
      ]),
    )
    const bound = Memory.of({
      index: (person) =>
        person === personId
          ? memory.index()
          : this.#remote(() => environment.PERSONS.getByName(person).memoryIndex(), MemoryIndex),
      list: (person, listing) =>
        person === personId
          ? memory.list(listing)
          : this.#remote(
              () => environment.PERSONS.getByName(person).listMemory(listing),
              MemoryPage,
            ),
      search: (person, search) =>
        person === personId
          ? memory.search(search)
          : this.#remote(
              () => environment.PERSONS.getByName(person).searchMemory(search),
              MemorySearchResult,
            ).pipe(Effect.flatMap(Effect.fromResult)),
      read: (person, address) =>
        person === personId
          ? memory.read(address)
          : this.#remote(
              () => environment.PERSONS.getByName(person).readMemory(address),
              MemoryReadResult,
            ).pipe(Effect.flatMap(Effect.fromResult)),
      write: (person, write) =>
        person === personId
          ? memory.write(write)
          : this.#remote(
              () => environment.PERSONS.getByName(person).writeMemory(write),
              MemoryWriteResult,
            ).pipe(Effect.flatMap(Effect.fromResult)),
      delete: (person, retraction) =>
        person === personId
          ? memory.delete(retraction)
          : this.#remote(
              () => environment.PERSONS.getByName(person).deleteMemory(retraction),
              MemoryDeleteResult,
            ).pipe(Effect.flatMap(Effect.fromResult), Effect.asVoid),
    })
    const runtime = await openCell({
      personId,
      storage: this.#state.storage,
      onWake: (wake) => {
        void this.#arm(wake).catch(() => this.#state.abort('Pi alarm write failed'))
      },
      memory: bound,
      skills: await Effect.runPromise(skills),
      environment,
    })
    void runtime.person.harness.closed.then((closed) => {
      if (closed.reason === 'failed') this.#state.abort('Pi storage failed')
    })
    await this.#arm(runtime.person.harness.wake())
    runtime.person.harness.resume()
    return { runtime, memory }
  }

  /** Native RPC is a real ingress, so decode its reply before exposing it to entry tools. */
  #remote<A, Encoded>(
    call: () => Promise<Encoded>,
    schema: Schema.Decoder<A>,
  ): Effect.Effect<A, MemoryUnavailable> {
    return Effect.tryPromise({ try: call, catch: () => MemoryUnavailable.make({}) }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => MemoryUnavailable.make({})),
    )
  }

  /** Pi owns the wake decision. celld owns durable alarms and instance lifetime. */
  // @effect-diagnostics-next-line asyncFunction:off -- celld invokes this native host adapter through its Promise API.
  async #arm(wake: Wake) {
    const heartbeat = wake.active ? Date.now() + HEARTBEAT : undefined
    const at =
      heartbeat === undefined
        ? wake.at
        : wake.at === undefined
          ? heartbeat
          : Math.min(heartbeat, wake.at)
    if (at === undefined) await this.#state.storage.deleteAlarm()
    else await this.#state.storage.setAlarm(at)
  }

  /** Arm before the router can submit or abort work, as Pi's first-party DO example requires. */
  // @effect-diagnostics-next-line asyncFunction:off -- celld invokes this native host adapter through its Promise API.
  async fetch(request: Request) {
    const { runtime } = await this.#ready
    if (request.method === 'POST')
      await this.#arm({ ...runtime.person.harness.wake(), active: true })
    const response = await runtime.fetch(request)
    // Pi keeps committing after admission. Keep that event live until its work is idle so
    // a later Stop can settle cancellation through celld's event-bound input gate.
    this.#state.waitUntil(runtime.person.harness.waitForIdle(BACKGROUND_CONTEXT))
    await this.#arm(runtime.person.harness.wake())
    return response
  }

  /** An alarm resumes due native tasks and work interrupted by a lost owner. */
  // @effect-diagnostics-next-line asyncFunction:off -- celld invokes this native host adapter through its Promise API.
  async alarm() {
    const { runtime } = await this.#ready
    await this.#arm({ ...runtime.person.harness.wake(), active: true })
    runtime.person.harness.resume()
    await this.#arm(runtime.person.harness.wake())
  }

  /** Cross-cell memory calls expose only the memory of this already named cell. */
  // @effect-diagnostics-next-line asyncFunction:off -- celld invokes this native host adapter through its Promise API.
  async memoryIndex() {
    return Effect.runPromise((await this.#ready).memory.index())
  }
  /** Validate the page request at native RPC ingress; the target is this already named Person. */
  // @effect-diagnostics-next-line asyncFunction:off -- Native celld RPC is a Promise boundary.
  async listMemory(listing: MemoryListing) {
    const { memory } = await this.#ready
    return Effect.runPromise(
      decodeListing(listing).pipe(
        Effect.flatMap((value) => memory.list(value)),
        Effect.mapError(() => MemoryUnavailable.make({})),
      ),
    )
  }
  /** Preserve invalid-query errors through native RPC so the model can correct its expression. */
  // @effect-diagnostics-next-line asyncFunction:off -- Native celld RPC is a Promise boundary.
  async searchMemory(search: MemorySearch) {
    const { memory } = await this.#ready
    return Effect.runPromise(
      decodeSearch(search).pipe(
        Effect.flatMap((value) => memory.search(value)),
        Effect.catchTag('SchemaError', () => Effect.fail(MemoryUnavailable.make({}))),
        Effect.result,
        Effect.flatMap(encodeSearch),
      ),
    )
  }
  /** Encode typed absence and conflicts so native RPC cannot flatten them into unavailability. */
  // @effect-diagnostics-next-line asyncFunction:off -- Native celld RPC is a Promise boundary.
  async readMemory(address: MemoryAddress) {
    const { memory } = await this.#ready
    return Effect.runPromise(
      decodeAddress(address).pipe(
        Effect.flatMap((value) => memory.read(value)),
        Effect.catchTag('SchemaError', () => Effect.fail(MemoryUnavailable.make({}))),
        Effect.result,
        Effect.flatMap(encodeRead),
      ),
    )
  }
  /** Only host calls carry write authority. The model never receives this native stub. */
  // @effect-diagnostics-next-line asyncFunction:off -- Native celld RPC is a Promise boundary.
  async writeMemory(write: MemoryWrite) {
    const { memory } = await this.#ready
    return Effect.runPromise(
      decodeWrite(write).pipe(
        Effect.flatMap((value) => memory.write(value)),
        Effect.catchTag('SchemaError', () => Effect.fail(MemoryUnavailable.make({}))),
        Effect.result,
        Effect.flatMap(encodeWrite),
      ),
    )
  }
  /** A local retraction receipt never promises that cross-layer forgetting is complete. */
  // @effect-diagnostics-next-line asyncFunction:off -- Native celld RPC is a Promise boundary.
  async deleteMemory(retraction: MemoryRetraction) {
    const { memory } = await this.#ready
    return Effect.runPromise(
      decodeRetraction(retraction).pipe(
        Effect.flatMap((value) => memory.delete(value)),
        Effect.as(true),
        Effect.catchTag('SchemaError', () => Effect.fail(MemoryUnavailable.make({}))),
        Effect.result,
        Effect.flatMap(encodeRetraction),
      ),
    )
  }
}

/** The public Worker checks the private credential before activating a named Person cell. */
export default {
  // @effect-diagnostics-next-line asyncFunction:off -- celld invokes this native host adapter through its Promise API.
  async fetch(request: Request, environment: Environment) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ service: 'vivid-cells', status: 'ok' })
    const token = await Effect.runPromise(
      Config.Redacted('VIVID_RUNTIME_TOKEN').pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(environment),
        ),
      ),
    )
    const authorization = request.headers.get('authorization')
    if (!isAuthorized(authorization === null ? '' : authorization, token))
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const match = /^\/persons\/([^/]+)\/(?:threads\/|history$|memory(?:$|\/))/u.exec(url.pathname)
    const person = personOption(match === null ? undefined : match[1])
    if (Option.isNone(person)) return Response.json({ error: 'InvalidRequest' }, { status: 400 })
    return environment.PERSONS.getByName(person.value).fetch(request)
  },
}
