import { DurableObject } from 'cloudflare:workers'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { DurableObjectSqliteDatabase } from '@earendil-works/chord/sqlite/cloudflare'
import type { DurableObjectSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import type { TaskInspection, Wake } from '@earendil-works/pi-durable'
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
  RuntimeContract,
  RuntimeRefusal,
} from '@vivid/contracts'
import { contractFingerprint } from '@vivid/contracts/fingerprint'
import memoryMigration from './memory/migrations/20261028123228_memory/migration.sql'
import searchMigration from './memory/migrations/20261028123228_memory-search/migration.sql'
import provenanceMigration from './memory/migrations/20261029131056_memory-provenance/migration.sql'
import { Config, ConfigProvider, Deferred, Effect, Exit, Option, Schema } from 'effect'
import { skills } from './skills.ts'

type CellPerson = Awaited<ReturnType<typeof openCell>>['person']

/** A task that commits now, not when the clock or another task lets it. */
const moving: ReadonlySet<TaskInspection['state']['kind']> = new Set(['running', 'ready'])

/**
 * Resolve once this Person has no work that can commit now: foreground idle, the settlement
 * follower drained (it starts learning), and no task running or ready. Learning is a
 * background task, which Pi's `waitForIdle` deliberately does not wait for. It waits for the
 * next commit and looks again, never for a task to finish: a task that goes to sleep or waits
 * on another stops committing without ending. Sleeping and waiting tasks are left to the
 * alarm, which arms from `wake()` and wakes them through the carrier like any other work.
 */
const settled = Effect.fn('Cell.settled')(function* (person: CellPerson) {
  const { harness } = person
  for (;;) {
    yield* Effect.tryPromise(() => harness.waitForIdle(BACKGROUND_CONTEXT))
    yield* person.quiet
    // Listen before looking, so a commit between the look and the wait is not missed.
    const committed = yield* Deferred.make<void>()
    const stop = harness.subscribeCommits(() => {
      Deferred.doneUnsafe(committed, Effect.void)
    })
    const live = yield* Effect.tryPromise(() => harness.inspect(BACKGROUND_CONTEXT)).pipe(
      Effect.map(({ tasks }) => tasks.some((task) => moving.has(task.state.kind))),
      Effect.tap((busy) => (busy ? Deferred.await(committed) : Effect.void)),
      Effect.ensuring(Effect.sync(stop)),
    )
    if (!live) return
  }
})

/** Host work the carrier runs inside its own event. It never rejects; it answers its caller. */
type Job = () => Promise<void>

/** A carrier job threw before answering: the router or the alarm's wake. celld answers 500. */
class CarrierFailed extends Schema.TaggedError<CarrierFailed>()(
  'CarrierFailed',
  { cause: Schema.Defect() },
  { title: 'Person cell could not answer' },
) {}
const failed = (cause: unknown) => Exit.fail(CarrierFailed.make({ cause }))

/** The event that runs this Person's Pi work, and the work queued for it. */
interface Carrier {
  readonly jobs: Job[]
  /** Wakes the carrier's loop when a job is queued or ends. */
  wake: () => void
}

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
  #carrier: Option.Option<Carrier> = Option.none()
  readonly #ready: Promise<{
    readonly runtime: Awaited<ReturnType<typeof openCell>>
    readonly memory: Effect.Success<ReturnType<typeof openMemory>>
  }>

  constructor(state: CellState, environment: Environment) {
    super(state, environment)
    this.#state = state
    this.#ready = state.blockConcurrencyWhile(() => this.#open(environment))
  }

  /**
   * Opening uses only local SQLite and configuration. Recovery starts in the carrier, after the
   * alarm is armed here, so recovered tasks run in an event that outlives them.
   */
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
        provenanceMigration,
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
    return { runtime, memory }
  }

  /**
   * Queue `job` on the carrier event, making this event the carrier when none is live.
   *
   * celld admits a transaction only from a continuation whose event is still live
   * (`op_gate_acquire`, `js.rs`); a later commit fails with "the cell event ended before it could
   * acquire an input gate" and Pi fails the whole Session. A continuation belongs to the event
   * that registered it, and Pi's scheduler starts every reserved task from whichever call began
   * its drain loop (`scheduler.js` `#kick`, `#drain`), so any event can end up owning any task.
   * Holding every request's own event until the Person was quiet kept those continuations alive,
   * but one held event per request piled up while Threads and learning overlapped, and celld
   * refused the cell (`cell_overload_refused in_flight=64`, verify at e66553a22). So all Pi work
   * runs here instead, from one event that ends only when nothing can commit now: celld holds
   * one event for the Person's work, plus the requests it is answering.
   */
  #carry(job: Job) {
    const carrier = Option.getOrElse(this.#carrier, () => this.#launch())
    carrier.jobs.push(job)
    carrier.wake()
  }

  /** The carrier's life is this event's `waitUntil`; the loop ends it once the Person is quiet. */
  #launch(): Carrier {
    const carrier: Carrier = { jobs: [], wake: () => {} }
    this.#carrier = Option.some(carrier)
    this.#state.waitUntil(
      this.#carryUntilQuiet(carrier).finally(() => {
        // A failed Harness ends the carrier early; queued jobs still answer their callers.
        if (Option.isSome(this.#carrier) && this.#carrier.value === carrier)
          this.#carrier = Option.none()
        for (const job of carrier.jobs.splice(0)) void job()
      }),
    )
    return carrier
  }

  /**
   * Start each queued job from this loop, so its continuations belong to the carrier event, and
   * end when no job runs and `settled` resolves with nothing queued. The loop's own awaits are
   * registered here, so it resumes in the carrier whichever event wakes it; an Effect fiber would
   * resume on the waker's event instead. The carrier is released in the same turn as the final
   * check, so a job queued after it starts the next carrier instead of joining one that is ending.
   */
  // @effect-diagnostics-next-line asyncFunction:off -- celld holds the carrier event through this Promise.
  async #carryUntilQuiet(carrier: Carrier) {
    const { runtime } = await this.#ready
    const { person } = runtime
    // Work a lost instance left, and due sleeps, start inside the carrier.
    person.harness.resume()
    let running = 0
    for (;;) {
      const woken = Deferred.makeUnsafe<boolean>()
      carrier.wake = () => {
        Deferred.doneUnsafe(woken, Effect.succeed(false))
      }
      for (let job = carrier.jobs.shift(); job !== undefined; job = carrier.jobs.shift()) {
        running++
        void job().then(() => {
          running--
          carrier.wake()
        })
      }
      // A new job interrupts the wait for quiet; the loop starts it and waits again once it ends.
      const quiet = await Effect.runPromise(
        running > 0
          ? Deferred.await(woken)
          : Effect.raceFirst(settled(person).pipe(Effect.as(true)), Deferred.await(woken)),
      )
      if (quiet && carrier.jobs.length === 0) {
        this.#carrier = Option.none()
        return
      }
    }
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

  /**
   * Answer through the carrier. The request body is read here, because it is this event's I/O,
   * and the router runs in the carrier.
   */
  // @effect-diagnostics-next-line asyncFunction:off -- celld invokes this native host adapter through its Promise API.
  async fetch(request: Request) {
    const body = request.method === 'GET' ? null : await request.arrayBuffer()
    const copy = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body,
    })
    const head = Deferred.makeUnsafe<Response, CarrierFailed>()
    this.#carry(() => this.#answer(copy, head))
    return Effect.runPromise(Deferred.await(head))
  }

  /**
   * Route in the carrier and pump the body there too: pulling a stream runs its producer, and a
   * settlement or state stream calls into Pi when it is pulled. A client that goes away cancels
   * the pipe, which ends this answer; it is not a failure.
   */
  // @effect-diagnostics-next-line asyncFunction:off -- The carrier runs native host jobs as Promises.
  async #answer(request: Request, head: Deferred.Deferred<Response, CarrierFailed>) {
    const routed = await this.#route(request).then(Exit.succeed, failed)
    if (Exit.isFailure(routed) || routed.value.body === null) {
      Deferred.doneUnsafe(head, routed)
      return
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    Deferred.doneUnsafe(head, Effect.succeed(new Response(readable, routed.value)))
    await routed.value.body.pipeTo(writable).then(
      () => undefined,
      () => undefined,
    )
  }

  /** Arm before the router can submit or abort work, as Pi's first-party DO example requires. */
  // @effect-diagnostics-next-line asyncFunction:off -- The carrier runs native host jobs as Promises.
  async #route(request: Request) {
    const { runtime } = await this.#ready
    if (request.method === 'POST')
      await this.#arm({ ...runtime.person.harness.wake(), active: true })
    const response = await runtime.fetch(request)
    await this.#arm(runtime.person.harness.wake())
    return response
  }

  /** An alarm resumes due native tasks and work interrupted by a lost owner, in the carrier. */
  // @effect-diagnostics-next-line asyncFunction:off -- celld invokes this native host adapter through its Promise API.
  async alarm() {
    const done = Deferred.makeUnsafe<void, CarrierFailed>()
    this.#carry(() =>
      this.#wake()
        .then(Exit.succeed, failed)
        .then((exit) => {
          Deferred.doneUnsafe(done, exit)
        }),
    )
    await Effect.runPromise(Deferred.await(done))
  }

  // @effect-diagnostics-next-line asyncFunction:off -- The carrier runs native host jobs as Promises.
  async #wake() {
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

/**
 * A refusal the Worker answers itself, before any Person cell: the same `RuntimeRefusal` a cell
 * answers, with the Worker's one hop and its contract fingerprint, so the server reads it the
 * same way and can tell which build refused.
 */
const refusal = (error: RuntimeRefusal['error'], status: 400 | 401, tag: string) =>
  Response.json(
    {
      error,
      cause: [{ service: 'cell', operation: 'Cells.fetch', tag, status }],
      contract: contractFingerprint,
    } satisfies typeof RuntimeRefusal.Encoded,
    { status },
  )

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
      return refusal('Unauthorized', 401, 'Unauthorized')
    // The server's readiness reads which contract this published Worker was built with.
    if (url.pathname === '/contract')
      return Response.json({
        contract: contractFingerprint,
      } satisfies typeof RuntimeContract.Encoded)
    const match = /^\/persons\/([^/]+)\/(?:threads\/|history$|search$|memory(?:$|\/))/u.exec(
      url.pathname,
    )
    const person = personOption(match === null ? undefined : match[1])
    if (Option.isNone(person)) return refusal('InvalidRequest', 400, 'PersonUnaddressed')
    return environment.PERSONS.getByName(person.value).fetch(request)
  },
}
