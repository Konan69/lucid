import * as NodeCrypto from 'node:crypto'
import * as NodeURL from 'node:url'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { createSelectSchema } from 'drizzle-orm/effect-schema'
import * as Arr from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import {
  Conflict,
  DatabaseFailure,
  HandoffField,
  HandoffFieldId,
  HandoffFieldReceipt,
  HandoffFieldResult,
  HandoffFormKind,
  HandoffFormState,
  HandoffId,
  HandoffKind,
  HandoffPage,
  HandoffRequest,
  type HandoffRefusalReason,
  HandoffScreenState,
  InvalidRequest,
  NotFound,
  PersonId,
  PrepareHandoffOutcome,
  PrepareHandoffRequest,
  RunId,
  ThreadId,
  type FillHandoffRequest,
  type PersonSummary,
} from '@vivid/contracts'
import {
  HandoffClosed,
  HandoffComputerUnavailable,
  HandoffNotAddressee,
} from '@vivid/contracts/rpc'
import { companyColumnOf, inWorkspace, loadSummaries, type Actor } from '../auth/access.ts'
import { ActionOrigin, actionOrigin } from '../approvals/gate.ts'
import { replaySignals, type SignalWriter } from '../approvals/replay.ts'
import { Signal, encodeSignal } from '../approvals/signal.ts'
import {
  ComputerStore,
  executionReason,
  executionRefusals,
  machineFailureReason,
  type ComputerNotReady,
} from '../computers/store.ts'
import { HandoffPageBinding, type MachineFailure } from '../computers/machine.ts'
import {
  Database,
  decodeStored,
  encodeStored,
  returned,
  type DatabaseInfrastructureError,
} from '../database/client.ts'
import { announceFeed } from '../feed/changes.ts'
import { changed, Topic } from '../live/changes.ts'
import { Notifier } from '../notifications/notifier.ts'
import { readableBy, requireThread } from '../threads/access.ts'
import { DeliveryMessage } from '../threads/conversation.ts'
import { notifiesFrom } from '../threads/place.ts'
import { threads } from '../threads/tables.ts'
import { handoffs } from './tables.ts'

/**
 * Handoffs: the one step on the Computer only the Person can do (a sign-in, a code, a payment, a
 * CAPTCHA, taking control), prepared by Vivid and finished by the Person asked, after which the
 * work carries on in the same Thread by itself.
 *
 * What makes it safe is what is never kept. A value the Person types travels from their request
 * to the Computer's browser (`ComputerStore.fillFields`) and nowhere else: not in a row, a signal,
 * a log line, a span or an error. Vivid is told one result per field. While a handoff is open the
 * Computer is held for it (`computers/store.ts` `load`), so Vivid cannot read the page the values
 * are on; finishing or withdrawing empties the fields still there before Vivid has it back.
 *
 * Continuation follows questions (`store.ts` `answer`): finishing writes an owed signal in the
 * same transaction, and the shared replay delivers it as a Decision (`approvals/replay.ts`). It
 * joins the running response or starts the next Run in the Thread; the Run id is not kept.
 *
 * The design is Grok Bot's secure handoff and write-only fill, read in
 * `~/ref/system-prompts-mined/mined/grok-bot-skills.md` (M10): preflight on the current page,
 * fill privately, status per field, no screenshot of a secret. Its held-value remapping (M11) and
 * one-code submit are not here: nothing is kept to remap, and the Person always presses submit.
 */

/** What a handoff is, as its row keeps it: the form's fields or the live-screen kind. */
const Definition = Schema.TaggedUnion({
  Form: { kind: HandoffFormKind, fields: Schema.NonEmptyArray(HandoffField) },
  Screen: { kind: HandoffKind },
})
type Definition = typeof Definition.Type
const Receipts = Schema.NonEmptyArray(HandoffFieldReceipt)

const columns = Schema.Struct(createSelectSchema(handoffs, {
  id: HandoffId,
  threadId: ThreadId,
  runId: RunId,
  personId: PersonId,
  request: Definition,
  page: HandoffPage,
  binding: HandoffPageBinding,
  status: Schema.Literals(['waiting', 'applying', 'ready', 'completed', 'withdrawn']),
  receipts: Schema.NullOr(Receipts),
  completedBy: Schema.NullOr(PersonId),
  settledAt: Schema.NullOr(Schema.Finite),
  signal: Signal,
}).fields)
const decodeRow = decodeStored(columns, 'Handoff')
type Row = typeof columns.Type
const encodeDefinition = encodeStored(Definition, 'Handoff request')
const encodePage = encodeStored(HandoffPage, 'Handoff page')
const encodeBinding = encodeStored(HandoffPageBinding, 'Handoff page binding')
const encodeReceipts = encodeStored(Receipts, 'Handoff receipts')

/** The statuses in which a handoff holds the Computer and waits on the Person. */
const OPEN = ['waiting', 'applying', 'ready'] as const

/** The delivery key of a finished handoff; a repeated finish can never owe a second signal. */
const handoffKey = (id: HandoffId) => `handoff-${id}`

/** Replay supplies the selection and fences; this domain owns both complete signal writes. */
export const handoffSignals: SignalWriter = {
  table: handoffs,
  claim: Effect.fn('Handoffs.claimSignals')(function* (database, update) {
    return yield* database.run(
      database
        .update(handoffs)
        .set({ signalDueAt: update.leaseUntil, signalClaim: update.token })
        .where(update.where)
        .returning({
          id: handoffs.id,
          threadId: handoffs.threadId,
          personId: handoffs.personId,
          signal: handoffs.signal,
        }),
    )
  }),
  settle: Effect.fn('Handoffs.settleSignal')(function* (database, update) {
    yield* database.run(
      database
        .update(handoffs)
        .set({ signal: update.signal, signalDueAt: update.dueAt, signalClaim: null })
        .where(and(eq(handoffs.id, update.id), eq(handoffs.signalClaim, update.token))),
    )
  }),
}

const corrupt = () => new DatabaseFailure({ message: 'Handoff record is inconsistent' })

/** A settled row must say who and when; anything else is a record that cannot be drawn. */
const completion = (row: Row, people: ReadonlyMap<PersonId, PersonSummary>) => {
  const by = Option.flatMap(Option.fromNullishOr(row.completedBy), (id) =>
    Option.fromUndefinedOr(people.get(id)),
  )
  return Option.isSome(by) && row.settledAt !== null
    ? Effect.succeed({ completedBy: by.value, completedAt: row.settledAt })
    : Effect.fail(corrupt())
}

/** A form's state from its row: receipts exist exactly once a fill was typed. */
const formState = Effect.fn('Handoffs.formState')(function* (
  row: Row,
  people: ReadonlyMap<PersonId, PersonSummary>,
) {
  switch (row.status) {
    case 'waiting':
      return HandoffFormState.cases.Waiting.make({})
    case 'applying':
      return HandoffFormState.cases.Applying.make({})
    case 'ready':
      if (row.receipts === null) return yield* corrupt()
      return HandoffFormState.cases.Ready.make({ fields: row.receipts })
    case 'completed':
      if (row.receipts === null) return yield* corrupt()
      return HandoffFormState.cases.Completed.make({
        ...(yield* completion(row, people)),
        fields: row.receipts,
      })
    case 'withdrawn':
      if (row.settledAt === null) return yield* corrupt()
      return HandoffFormState.cases.Withdrawn.make({ withdrawnAt: row.settledAt })
  }
})

/** A live-screen step has no fill, so it is never applying and never has receipts. */
const screenState = Effect.fn('Handoffs.screenState')(function* (
  row: Row,
  people: ReadonlyMap<PersonId, PersonSummary>,
) {
  switch (row.status) {
    case 'waiting':
      return HandoffScreenState.cases.Waiting.make({})
    case 'ready':
      return HandoffScreenState.cases.Ready.make({})
    case 'completed':
      return HandoffScreenState.cases.Completed.make(yield* completion(row, people))
    case 'withdrawn':
      if (row.settledAt === null) return yield* corrupt()
      return HandoffScreenState.cases.Withdrawn.make({ withdrawnAt: row.settledAt })
    case 'applying':
      return yield* corrupt()
  }
})

/** Decodes rows once at ingress and batches the identities they name. */
const view = Effect.fn('Handoffs.view')(function* (
  values: ReadonlyArray<typeof handoffs.$inferSelect>,
) {
  const rows = yield* Effect.forEach(values, decodeRow)
  const people = yield* loadSummaries(
    rows.flatMap((row) => [row.personId, ...Option.toArray(Option.fromNullishOr(row.completedBy))]),
  )
  return yield* Effect.forEach(
    rows,
    Effect.fn('Handoffs.viewOne')(function* (row) {
      const askedOf = people.get(row.personId)
      if (askedOf === undefined) return yield* corrupt()
      const identity = {
        id: row.id,
        threadId: row.threadId,
        runId: row.runId,
        askedOf,
        page: row.page,
        summary: row.summary,
        createdAt: row.createdAt,
      }
      return yield* Definition.match<Effect.Effect<HandoffRequest, DatabaseFailure>>(row.request, {
        Form: ({ kind, fields }) =>
          formState(row, people).pipe(
            Effect.map((state) =>
              HandoffRequest.cases.Form.make({ ...identity, kind, fields, state }),
            ),
          ),
        Screen: ({ kind }) =>
          screenState(row, people).pipe(
            Effect.map((state) => HandoffRequest.cases.Screen.make({ ...identity, kind, state })),
          ),
      })
    }),
  )
})

/** Every handoff in a Thread, oldest first; the Thread's access was checked by its reader. */
export const handoffsInThread = Effect.fn('Handoffs.inThread')(function* (threadId: ThreadId) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select()
      .from(handoffs)
      .where(eq(handoffs.threadId, threadId))
      .orderBy(asc(handoffs.createdAt), asc(handoffs.id)),
  )
  return yield* view(rows)
})

/** The open handoffs waiting on this Person, in Threads they can still read in this workspace. */
export const handoffsWaiting = Effect.fn('Handoffs.waiting')(function* (actor: Actor) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ handoff: handoffs })
      .from(handoffs)
      .innerJoin(threads, eq(threads.id, handoffs.threadId))
      .where(
        and(
          eq(handoffs.personId, actor.person.id),
          inArray(handoffs.status, OPEN),
          inWorkspace(threads, actor),
          readableBy(actor.person.id),
        ),
      )
      .orderBy(asc(handoffs.createdAt), asc(handoffs.id)),
  )
  return yield* view(rows.map((row) => row.handoff))
})

/**
 * The page as a Person reads it: origin and path, never the query or fragment, which can hold a
 * session or a reset token. A page that is not on the web (a blank tab) cannot be handed over.
 */
const publicPage = (address: string) => {
  const url = URL.canParse(address) ? Option.some(new NodeURL.URL(address)) : Option.none()
  return Option.filter(url, (value) => value.protocol === 'https:' || value.protocol === 'http:').pipe(
    Option.map((value) =>
      HandoffPage.make({ origin: value.origin, address: `${value.origin}${value.pathname}` }),
    ),
  )
}

/** The Run that is handing the step over; a step is never handed over from outside one. */
const actingRun = (actor: Actor) =>
  actionOrigin(actor).pipe(
    Effect.map(
      (origin): Option.Option<{ readonly threadId: ThreadId; readonly runId: RunId }> =>
        ActionOrigin.guards.Run(origin)
          ? Option.some({ threadId: origin.threadId, runId: origin.runId })
          : Option.none(),
    ),
    Effect.catchTag('NotFound', () => Effect.succeedNone),
  )

/** Whether this Person already has a handoff waiting: one at a time holds their Computer. */
const openFor = Effect.fn('Handoffs.openFor')(function* (person: PersonId) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ id: handoffs.id })
      .from(handoffs)
      .where(and(eq(handoffs.personId, person), inArray(handoffs.status, OPEN)))
      .limit(1),
  )
  return rows.length > 0
})

/** The labels Vivid asked to prepare; a live-screen step prepares none. */
const labelsOf = (request: PrepareHandoffRequest) =>
  PrepareHandoffRequest.match(request, {
    Form: ({ fields }) => fields.map((field) => field.label),
    Screen: () => [],
  })

/** The definition kept for the request, with a server-made id for every field. */
const definitionOf = (request: PrepareHandoffRequest): Definition =>
  PrepareHandoffRequest.match<Definition>(request, {
    Form: ({ kind, fields }) =>
      Definition.cases.Form.make({
        kind,
        fields: Arr.map(fields, (field) =>
          HandoffField.make({
            id: HandoffFieldId.make(NodeCrypto.randomUUID()),
            label: field.label,
            purpose: field.purpose,
          }),
        ),
      }),
    Screen: ({ kind }) => Definition.cases.Screen.make({ kind }),
  })

/** Labels the page could not offer as one editable field, with why. */
const refusalsOf = (
  labels: ReadonlyArray<string>,
  found: ReadonlyArray<Option.Option<HandoffRefusalReason>>,
) =>
  labels.flatMap((label, index) =>
    Option.match(Option.flatten(Option.fromUndefinedOr(found[index])), {
      onNone: () => [],
      onSome: (reason) => [{ label, reason }],
    }),
  )

/** The preflight, with a Computer Vivid cannot use said as a reason it can act on. */
const preflight = (person: PersonId, labels: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const computer = yield* ComputerStore
    return yield* computer.findFields(person, labels).pipe(
      Effect.map((found) => Result.succeed(found)),
      // A read whose answer was lost changed nothing; the step cannot be prepared now.
      Effect.catchTag('MachineExecutionUnknown', (failure) =>
        Effect.succeed(Result.fail(machineFailureReason(failure))),
      ),
      Effect.catchTags(
        executionRefusals((failure) => Effect.succeed(Result.fail(executionReason(failure)))),
      ),
    )
  })

/** The Person asked hears about the step where they hear about questions. */
const announce = Effect.fn('Handoffs.announce')(function* (
  actor: Actor,
  thread: Pick<Effect.Success<ReturnType<typeof requireThread>>, 'id' | 'companyId' | 'place'>,
  summary: string,
) {
  yield* changed(actor, Topic.thread(thread.id))
  // A step handed over in a Background Thread is shown by the Feed, never as a notification.
  if (!notifiesFrom(thread.place)) return
  yield* (yield* Notifier).notify({
    personId: actor.person.id,
    companyId: thread.companyId,
    kind: 'needs-you',
    title: 'Vivid needs you for one step',
    body: summary,
    threadId: thread.id,
  })
})

/**
 * Vivid hands the Person one step. The fields are found on the page the Computer shows now,
 * before the Person is asked, so a form never asks for a value it cannot type; one that cannot be
 * prepared is refused by label, and Vivid hands it over on the live screen instead.
 */
export const prepareHandoff = Effect.fn('Handoffs.prepare')(function* (
  actor: Actor,
  request: PrepareHandoffRequest,
) {
  const origin = yield* actingRun(actor)
  if (Option.isNone(origin)) return PrepareHandoffOutcome.cases.RunRequired.make({})
  const { threadId, runId } = origin.value
  const thread = yield* requireThread(threadId, actor.person.id)
  if (thread.companyId !== companyColumnOf(actor.workspace))
    return yield* new NotFound({ message: 'Thread not found in workspace' })
  if (yield* openFor(actor.person.id)) return PrepareHandoffOutcome.cases.Busy.make({})
  const labels = labelsOf(request)
  const found = yield* preflight(actor.person.id, labels)
  if (Result.isFailure(found))
    return PrepareHandoffOutcome.cases.Unavailable.make({ reason: found.failure })
  const refused = refusalsOf(labels, found.success.fields)
  if (Arr.isReadonlyArrayNonEmpty(refused))
    return PrepareHandoffOutcome.cases.FieldsRefused.make({ fields: refused })
  const page = publicPage(found.success.address)
  if (Option.isNone(page))
    return PrepareHandoffOutcome.cases.Unavailable.make({
      reason: 'The Computer’s browser does not show a web page to hand over.',
    })
  const database = yield* Database
  const values = {
    id: HandoffId.make(NodeCrypto.randomUUID()),
    threadId,
    runId,
    personId: actor.person.id,
    summary: request.summary,
    request: yield* encodeDefinition(definitionOf(request)),
    page: yield* encodePage(page.value),
    binding: yield* encodeBinding(found.success.page),
    status: 'waiting',
    createdAt: yield* Clock.currentTimeMillis,
  }
  const rows = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      // The open index admits one waiting handoff per Person; a race with another is Busy.
      const written = yield* tx.insert(handoffs).values(values).onConflictDoNothing().returning()
      if (written.length > 0) yield* announceFeed(tx, [threadId])
      return written
    }),
  )
  if (rows.length === 0) return PrepareHandoffOutcome.cases.Busy.make({})
  const handoff = yield* returned(yield* view(rows), 'Handoff')
  yield* announce(actor, thread, request.summary)
  return PrepareHandoffOutcome.cases.Prepared.make({ handoff })
})

/**
 * The handoff a Person's call is about, when it is theirs to act on. Only the Person asked may,
 * whoever else can read the Thread: the values go into their own Computer.
 */
const addressed = Effect.fn('Handoffs.addressed')(function* (actor: Actor, id: HandoffId) {
  const database = yield* Database
  const rows = yield* database.run(
    database
      .select({ handoff: handoffs })
      .from(handoffs)
      .innerJoin(threads, eq(threads.id, handoffs.threadId))
      .where(and(eq(handoffs.id, id), inWorkspace(threads, actor)))
      .limit(1),
  )
  const value = rows[0]
  if (value === undefined) return yield* new NotFound({ message: 'Handoff not found' })
  const row = yield* decodeRow(value.handoff)
  yield* requireThread(row.threadId, actor.person.id)
  if (row.personId !== actor.person.id) return yield* new HandoffNotAddressee({ id, message: 'Only the person asked can do this step.' })
  return row
})

/** The database's own failures, which stay what they are on a Person's call. */
const DATABASE: ReadonlySet<string> = new Set([
  'DatabaseFailure',
  'DatabaseUnavailable',
  'DatabaseConstraintViolation',
])
const isDatabase = (
  failure: DatabaseInfrastructureError | MachineFailure | ComputerNotReady,
): failure is DatabaseInfrastructureError => DATABASE.has(failure._tag)

/**
 * A Person's call that needs the Computer, with a Computer it could not use said as the reason
 * Vivid's own steps give (`executionReason`), and named in the log as they are.
 */
const throughComputer = <A>(
  id: HandoffId,
  work: Effect.Effect<A, DatabaseInfrastructureError | MachineFailure | ComputerNotReady>,
) =>
  work.pipe(
    Effect.tapError((failure) =>
      isDatabase(failure)
        ? Effect.void
        : Effect.logWarning('Computer could not be used', { failure: failure._tag }),
    ),
    Effect.mapError((failure) =>
      isDatabase(failure)
        ? failure
        : new HandoffComputerUnavailable({ id, reason: executionReason(failure) }),
    ),
  )

const closed = (id: HandoffId) =>
  new HandoffClosed({ id, message: 'This step is already over.' })

/** The public record of one row, after a write that returned it. */
const one = Effect.fn('Handoffs.one')(function* (
  rows: ReadonlyArray<typeof handoffs.$inferSelect>,
) {
  return yield* returned(yield* view(rows), 'Handoff')
})

/** The current record, read again: what a call that changed nothing answers. */
const current = Effect.fn('Handoffs.current')(function* (id: HandoffId) {
  const database = yield* Database
  return yield* one(yield* database.run(database.select().from(handoffs).where(eq(handoffs.id, id))))
})

/**
 * The Person takes the live screen for a step done there. The Computer is already held for the
 * handoff; this records that the Person has it, which is when finishing becomes possible.
 */
export const beginHandoff = Effect.fn('Handoffs.begin')(function* (actor: Actor, id: HandoffId) {
  const row = yield* addressed(actor, id)
  if (row.status === 'completed' || row.status === 'withdrawn') return yield* closed(id)
  if (!Definition.guards.Screen(row.request))
    return yield* new InvalidRequest({ message: 'A form is begun by filling it.' })
  const database = yield* Database
  const rows = yield* database.run(
    database
      .update(handoffs)
      .set({ status: 'ready' })
      .where(and(eq(handoffs.id, id), eq(handoffs.status, 'waiting')))
      .returning(),
  )
  yield* changed(actor, Topic.thread(row.threadId))
  return rows.length > 0 ? yield* one(rows) : yield* current(id)
})

/**
 * The values supplied for a form, paired with their fields. The first fill covers every field so
 * that each has a result; a later one fills again only those the Person chose, usually the ones
 * refused. Each field at most once, and only fields of this form.
 */
const entriesOf = (
  fields: ReadonlyArray<HandoffField>,
  request: FillHandoffRequest,
  first: boolean,
) => {
  const ids = request.values.map((value) => value.fieldId)
  const known = ids.every((value) => fields.some((field) => field.id === value))
  const once = new Set(ids).size === ids.length
  if (!known || !once || (first && ids.length !== fields.length)) return Option.none()
  return Option.some(
    request.values.flatMap((value) =>
      fields
        .filter((field) => field.id === value.fieldId)
        .map((field) => ({ field, entry: { label: field.label, value: value.value } })),
    ),
  )
}

/**
 * The latest result per field: fields filled again replace their earlier result. The first fill
 * covers every field, so each has one; a row where one is missing is inconsistent.
 */
const merged = (
  fields: Arr.NonEmptyReadonlyArray<HandoffField>,
  before: ReadonlyArray<HandoffFieldReceipt>,
  now: ReadonlyArray<HandoffFieldReceipt>,
) =>
  Effect.forEach(fields, (field) =>
    Effect.fromOption(
      Arr.findFirst([...now, ...before], (receipt) => receipt.fieldId === field.id),
    ).pipe(Effect.mapError(corrupt)),
  ).pipe(Effect.filterOrFail(Arr.isReadonlyArrayNonEmpty, corrupt))

/**
 * Empties the form's fields that are still on the page, before Vivid can read it again. A
 * Computer that is not running has no page holding them. Any other failure leaves the handoff open
 * and the Computer held, so nothing typed is exposed; the Person may try again.
 */
const clearOf = Effect.fn('Handoffs.clear')(function* (row: Row) {
  if (!Definition.guards.Form(row.request)) return
  const labels = row.request.fields.map((field) => field.label)
  const computer = yield* ComputerStore
  yield* throughComputer(
    row.id,
    computer.clearFields(row.personId, row.binding, labels).pipe(
      Effect.catchTags({
        ComputerNotReady: () => Effect.void,
        MachineNotRunning: () => Effect.void,
      }),
    ),
  )
})

/**
 * Types the Person's values into the prepared fields, privately, and keeps one result per field.
 *
 * The row is claimed (`applying`) before anything is typed, so a second fill racing this one is
 * refused rather than typed twice. Values exist only in this call's memory and the driver's
 * private input file; the row gets the receipts. A Computer that cannot be reached types nothing
 * and the claim is given back. Uninterruptible once claimed: a fill is never left half recorded
 * by a cancelled request.
 */
export const fillHandoff = Effect.fn('Handoffs.fill')(function* (
  actor: Actor,
  request: FillHandoffRequest,
) {
  const row = yield* addressed(actor, request.id)
  if (row.status === 'completed' || row.status === 'withdrawn') return yield* closed(request.id)
  if (!Definition.guards.Form(row.request))
    return yield* new InvalidRequest({ message: 'This step is done on the screen.' })
  const { fields } = row.request
  const entries = entriesOf(fields, request, row.status === 'waiting')
  if (Option.isNone(entries))
    return yield* new InvalidRequest({ message: 'Fill each field of this step once.' })
  const database = yield* Database
  const claimed = yield* database.run(
    database
      .update(handoffs)
      .set({ status: 'applying' })
      .where(and(eq(handoffs.id, row.id), inArray(handoffs.status, ['waiting', 'ready'])))
      .returning(),
  )
  if (claimed.length === 0) return yield* new Conflict({ message: 'This step is being filled.' })
  const before = yield* decodeRow(yield* returned(claimed, 'Handoff'))
  const computer = yield* ComputerStore
  const results = yield* throughComputer(
    row.id,
    computer.fillFields(
      actor.person.id,
      row.binding,
      entries.value.map((item) => item.entry),
    ),
  ).pipe(
    // Nothing was typed: give the claim back, with the receipts it had.
    Effect.tapError(() =>
      database.run(
        database
          .update(handoffs)
          .set({ status: row.status })
          .where(and(eq(handoffs.id, row.id), eq(handoffs.status, 'applying'))),
      ),
    ),
  )
  const receipts = yield* merged(
    fields,
    before.receipts === null ? [] : before.receipts,
    Arr.zipWith(entries.value, results, (item, result) =>
      HandoffFieldReceipt.make({ fieldId: item.field.id, result }),
    ),
  )
  const rows = yield* database.run(
    database
      .update(handoffs)
      .set({ status: 'ready', receipts: yield* encodeReceipts(receipts) })
      .where(and(eq(handoffs.id, row.id), eq(handoffs.status, 'applying')))
      .returning(),
  )
  yield* changed(actor, Topic.thread(row.threadId))
  if (rows.length > 0) return yield* one(rows)
  // Withdrawn while this fill was typing: its clearing may have run first, so the values just
  // typed would stay on a page Vivid has back. Clear again; the step is over either way.
  yield* clearOf(row)
  return yield* current(row.id)
}, Effect.uninterruptible)

/** A field's result as Vivid reads it: what happened, never what was typed. */
const resultWords = (result: HandoffFieldResult) =>
  HandoffFieldResult.match(result, {
    Filled: () => 'filled',
    Refused: ({ reason }) => {
      switch (reason) {
        case 'TargetChanged':
          return 'not filled, the page had changed'
        case 'TargetUnavailable':
          return 'not filled, the field was not found'
        case 'UnsupportedField':
          return 'not filled, the field could not be typed into'
      }
    },
    OutcomeUnknown: () => 'may have been filled; it was not typed again',
  })

/**
 * What Vivid is told when the Person finishes: the step, where, and each field's result by its
 * label. Written from typed results only; no page text, driver text or value reaches it. A fill is
 * not the site's answer, so Vivid is told to look at the page before going on.
 */
const finishedWords = (row: Row, by: string) =>
  Definition.match(row.request, {
    Form: ({ fields }) => {
      const results = fields.map((field) => {
        const receipt = (row.receipts === null ? [] : row.receipts).find(
          (item) => item.fieldId === field.id,
        )
        return `${field.label}: ${receipt === undefined ? 'not filled' : resultWords(receipt.result)}.`
      })
      return `${by} finished the step on ${row.page.origin} and handed the Computer back. ${results.join(' ')} Look at the page to see what the site did before going on.`
    },
    Screen: () =>
      `${by} finished the step on the Computer's screen at ${row.page.origin} and handed it back. Look at the page to see where things stand before going on.`,
  })

/** The Person had the screen for the step; it goes back to Vivid with the handoff. */
const handBack = (person: PersonId) =>
  Effect.gen(function* () {
    yield* (yield* ComputerStore).hold(person, false)
  })

/**
 * The Person has finished. The fields are emptied, the record and its owed signal are written in
 * one transaction, the screen is handed back, and the signal is delivered, so Vivid carries on in
 * the Thread without the Person writing anything. A second finish answers the first's record and
 * owes nothing more; finishing a withdrawn step is refused.
 */
export const completeHandoff = Effect.fn('Handoffs.complete')(function* (
  actor: Actor,
  id: HandoffId,
) {
  const row = yield* addressed(actor, id)
  if (row.status === 'completed') return yield* current(id)
  if (row.status === 'withdrawn') return yield* closed(id)
  if (row.status !== 'ready')
    return yield* new Conflict({
      message: Definition.guards.Form(row.request)
        ? 'Fill the fields first.'
        : 'Take the screen first.',
    })
  yield* clearOf(row)
  const now = yield* Clock.currentTimeMillis
  const signal = Signal.cases.Owed.make({
    idempotencyKey: handoffKey(id),
    deciderId: actor.person.id,
    message: DeliveryMessage.cases.Signal.make({
      type: 'handoff',
      body: finishedWords(row, actor.person.name),
      attributes: { handoff: id },
    }),
  })
  const database = yield* Database
  const rows = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const written = yield* tx
        .update(handoffs)
        .set({
          status: 'completed',
          completedBy: actor.person.id,
          settledAt: now,
          signal: yield* encodeSignal(signal),
          signalDueAt: now,
        })
        .where(and(eq(handoffs.id, id), eq(handoffs.status, 'ready')))
        .returning()
      if (written.length > 0) yield* announceFeed(tx, [row.threadId])
      return written
    }),
  )
  if (rows.length === 0) return yield* current(id)
  yield* handBack(actor.person.id)
  yield* changed(actor, Topic.thread(row.threadId))
  yield* replaySignals(handoffSignals, Option.some([id])).pipe(
    Effect.catch(() => Effect.logError('Handoff replay failed', { handoffId: id })),
  )
  return yield* one(rows)
}, Effect.uninterruptible)

/**
 * The Person no longer wants to do the step. The fields are emptied and the screen handed back;
 * Vivid is not woken, as a withdrawn question does not wake it. A fill whose answer was lost
 * leaves a handoff `applying`; withdrawing is how the Person ends it.
 */
export const withdrawHandoff = Effect.fn('Handoffs.withdraw')(function* (
  actor: Actor,
  id: HandoffId,
) {
  const row = yield* addressed(actor, id)
  if (row.status === 'completed' || row.status === 'withdrawn') return yield* closed(id)
  yield* clearOf(row)
  const database = yield* Database
  const rows = yield* database.transaction((tx) =>
    Effect.gen(function* () {
      const written = yield* tx
        .update(handoffs)
        .set({ status: 'withdrawn', settledAt: yield* Clock.currentTimeMillis })
        .where(and(eq(handoffs.id, id), inArray(handoffs.status, OPEN)))
        .returning()
      if (written.length > 0) yield* announceFeed(tx, [row.threadId])
      return written
    }),
  )
  if (rows.length === 0) return yield* closed(id)
  yield* handBack(actor.person.id)
  yield* changed(actor, Topic.thread(row.threadId))
  return yield* one(rows)
}, Effect.uninterruptible)
