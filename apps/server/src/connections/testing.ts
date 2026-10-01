import { eq, inArray } from 'drizzle-orm'
import { Clock, Context, Effect, Layer, Option, Ref } from 'effect'
import {
  Approval,
  ApprovalId,
  ApprovalState,
  AuditEvent,
  Company,
  CompanyId,
  ConnectionId,
  Person,
  PersonId,
  ProposedAction,
  ServiceAuthorization,
  ServiceId,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { type Actor, summaryOf } from '../auth/access.ts'
import { personTable } from '../auth/tables.ts'
import { companyTable, membershipTable } from '../companies/tables.ts'
import { Database } from '../database/client.ts'
import { testConfigLayer, testDatabaseLayer } from '../database/testdb.ts'
import { Audit } from '../audit/record.ts'
import { Gate, GateDecision, type GateExposure } from '../approvals/gate.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { threads } from '../threads/tables.ts'
import {
  Executor,
  ExecutorAppId,
  ExecutorAuthorizationId,
  ExecutorAccountId,
  ExecutorProfileId,
  ExecutorReferences,
  ExecutorServiceEntry,
  ExecutorStatus,
  ExecutorStep,
  ExecutorTool,
  ExecutorCallOutcome,
  ExecutorResumeOutcome,
} from './executor.ts'
import { connectionStoreLayer } from './store.ts'

export const serviceId = ServiceId.make('test-service')
export const readTool = ExecutorTool.make({
  name: 'read',
  description: 'Read records',
  effect: 'read',
  input: {},
})
export const writeTool = ExecutorTool.make({
  name: 'write',
  description: 'Write records',
  effect: 'write',
  input: {},
})

/** Recording authority keeps external behavior deliberate while exercising the production store and SQL. */
interface ConnectionProbeService {
  readonly calls: Ref.Ref<number>
  readonly signIns: Ref.Ref<number>
  readonly step: Ref.Ref<'Done' | 'OpenSignIn' | 'EnterKey'>
  readonly begins: Ref.Ref<number>
  readonly removals: Ref.Ref<number>
  readonly catalogs: Ref.Ref<number>
  readonly discoveries: Ref.Ref<number>
  readonly events: Ref.Ref<readonly AuditEvent[]>
  readonly checked: Ref.Ref<readonly { action: ProposedAction; exposure: GateExposure }[]>
  readonly decision: Ref.Ref<'Allowed' | 'Blocked' | 'ApprovalRequired'>
  readonly outcome: Ref.Ref<typeof ExecutorCallOutcome.Type>
}

export class ConnectionProbe extends Context.Service<ConnectionProbe, ConnectionProbeService>()(
  'vivid/ConnectionProbe',
) {}

/** Completion retains provider identity and supplies only an opaque account reference. */
const authorized = (references: ExecutorReferences) =>
  ExecutorReferences.cases.Authorized.make({
    service: references.service,
    app: references.app,
    profile: references.profile,
    owner: references.owner,
    account: ExecutorAccountId.make(crypto.randomUUID()),
  })

/** Source effects and recorded calls belong to the external adapter test boundary. */
const makeExecutor = (probe: ConnectionProbeService) => {
  return Executor.of({
    catalog: Effect.fn('Executor.Test.catalog')(function* () {
      yield* Ref.update(probe.catalogs, (count) => count + 1)
      return [
        ExecutorServiceEntry.make({
          id: serviceId,
          name: 'Records',
          description: 'Read and write records',
          authorization: ServiceAuthorization.cases.None.make({}),
        }),
      ]
    }),
    begin: Effect.fn('Executor.Test.begin')(function* (input) {
      yield* Ref.update(probe.begins, (count) => count + 1)
      const identity = {
        service: input.service,
        owner: input.owner,
        app: ExecutorAppId.make(crypto.randomUUID()),
        profile: ExecutorProfileId.make(crypto.randomUUID()),
      }
      const step = yield* Ref.get(probe.step)
      if (step === 'OpenSignIn')
        return ExecutorStep.cases.OpenSignIn.make({
          references: ExecutorReferences.cases.SigningIn.make({
            ...identity,
            authorization: ExecutorAuthorizationId.make(crypto.randomUUID()),
          }),
          address: 'https://example.test/sign-in',
        })
      if (step === 'EnterKey')
        return ExecutorStep.cases.EnterKey.make({
          references: ExecutorReferences.cases.EnteringKey.make({
            ...identity,
            authorization: ExecutorAuthorizationId.make(crypto.randomUUID()),
            method: 'key',
            label: input.label,
          }),
          fields: [{ name: 'key', label: 'Key' }],
        })
      return ExecutorStep.cases.Done.make({
        references: ExecutorReferences.cases.Public.make(identity),
      })
    }),
    complete: Effect.fn('Executor.Test.complete')(({ references }) =>
      Effect.succeed(authorized(references)),
    ),
    completeSignIn: Effect.fn('Executor.Test.signIn')(function* ({ references }) {
      yield* Ref.update(probe.signIns, (count) => count + 1)
      return authorized(references)
    }),
    status: Effect.fn('Executor.Test.status')((references) =>
      Effect.succeed(ExecutorStatus.cases.Ready.make({ references })),
    ),
    remove: Effect.fn('Executor.Test.remove')(() =>
      Ref.update(probe.removals, (count) => count + 1),
    ),
    tools: Effect.fn('Executor.Test.tools')(function* () {
      yield* Ref.update(probe.discoveries, (count) => count + 1)
      return [readTool, writeTool]
    }),
    call: Effect.fn('Executor.Test.call')(function* () {
      yield* Ref.update(probe.calls, (count) => count + 1)
      return yield* Ref.get(probe.outcome)
    }),
    resume: Effect.fn('Executor.Test.resume')(() =>
      Effect.succeed(ExecutorResumeOutcome.cases.Completed.make({ value: { resumed: true } })),
    ),
  })
}

/** A bounded Executor test Layer records dispatch and returns source-owned effects. */
const probeLayer = Layer.effectContext(
  Effect.gen(function* () {
    const probe = ConnectionProbe.of({
      calls: yield* Ref.make(0),
      signIns: yield* Ref.make(0),
      step: yield* Ref.make<'Done' | 'OpenSignIn' | 'EnterKey'>('Done'),
      begins: yield* Ref.make(0),
      removals: yield* Ref.make(0),
      catalogs: yield* Ref.make(0),
      discoveries: yield* Ref.make(0),
      events: yield* Ref.make<readonly AuditEvent[]>([]),
      checked: yield* Ref.make<readonly { action: ProposedAction; exposure: GateExposure }[]>([]),
      decision: yield* Ref.make<'Allowed' | 'Blocked' | 'ApprovalRequired'>('Allowed'),
      outcome: yield* Ref.make<typeof ExecutorCallOutcome.Type>(
        ExecutorCallOutcome.cases.Completed.make({ value: { ok: true } }),
      ),
    })
    const executor = makeExecutor(probe)
    const audit = Audit.of({
      record: Effect.fn('Audit.Test.record')((_actor, event) =>
        Ref.update(probe.events, (events) => [...events, event]),
      ),
    })
    const gate = Gate.of({
      check: Effect.fn('Gate.Test.check')(function* (actor, action, exposure) {
        yield* Ref.update(probe.checked, (checked) => [...checked, { action, exposure }])
        const decision = yield* Ref.get(probe.decision)
        if (decision === 'Allowed') return GateDecision.cases.Allowed.make({})
        if (decision === 'Blocked')
          return GateDecision.cases.Blocked.make({ rule: 'Never change records.' })
        const threadId = Option.getOrElse(actor.threadId, () => ThreadId.make('approval-test'))
        const now = yield* Clock.currentTimeMillis
        return GateDecision.cases.ApprovalRequired.make({
          approval: Approval.make({
            id: ApprovalId.make(crypto.randomUUID()),
            threadId,
            runId: null,
            action,
            digest: 'test-digest',
            askedOf: summaryOf(actor.person),
            state: ApprovalState.cases.Pending.make({ expiresAt: now + 60_000 }),
            createdAt: now,
          }),
        })
      }),
    })
    return Context.make(ConnectionProbe, probe).pipe(
      Context.add(Executor, executor),
      Context.add(Audit, audit),
      Context.add(Gate, gate),
    )
  }),
)

const dependencies = Layer.mergeAll(
  testDatabaseLayer,
  testConfigLayer,
  silentChangesLayer,
  probeLayer,
)
export const connectionTestLayer = connectionStoreLayer.pipe(Layer.provideMerge(dependencies))

/** Cleanup is installed before the first write and only touches unique disposable test identities. */
export const fixture = Effect.fn('Connections.Test.fixture')(function* () {
  const database = yield* Database
  const suffix = crypto.randomUUID()
  const owner = Person.make({
    id: PersonId.make(`connection-owner-${suffix}`),
    name: 'Owner',
    email: `owner-${suffix}@example.test`,
  })
  const member = Person.make({
    id: PersonId.make(`connection-member-${suffix}`),
    name: 'Member',
    email: `member-${suffix}@example.test`,
  })
  const company = Company.make({
    id: CompanyId.make(`connection-company-${suffix}`),
    name: 'Test Company',
    slug: `connection-company-${suffix}`,
  })
  const threadId = ThreadId.make(`connection-thread-${suffix}`)
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* database.run(database.delete(companyTable).where(eq(companyTable.id, company.id)))
      yield* database.run(
        database.delete(personTable).where(inArray(personTable.id, [owner.id, member.id])),
      )
    }).pipe(Effect.catch(() => Effect.logError('Connection fixture cleanup failed'))),
  )
  yield* database.run(database.insert(personTable).values([owner, member]))
  yield* database.run(
    database.insert(companyTable).values({ id: company.id, name: company.name, slug: company.id }),
  )
  yield* database.run(
    database.insert(membershipTable).values([
      { id: `owner-${suffix}`, companyId: company.id, userId: owner.id, role: 'owner' },
      { id: `member-${suffix}`, companyId: company.id, userId: member.id, role: 'member' },
    ]),
  )
  yield* database.run(
    database.insert(threads).values({
      id: threadId,
      title: 'Connection test',
      updatedAt: yield* Clock.currentTimeMillis,
      personId: owner.id,
      companyId: company.id,
      audience: 'company',
    }),
  )
  const ownerActor: Actor = {
    person: owner,
    workspace: Workspace.cases.Company.make({ company, role: 'owner' }),
    by: 'person',
    threadId: Option.none(),
  }
  const memberActor: Actor = {
    person: member,
    workspace: Workspace.cases.Company.make({ company, role: 'member' }),
    by: 'vivid',
    threadId: Option.some(threadId),
  }
  const personalActor: Actor = {
    person: owner,
    workspace: Workspace.cases.Personal.make({}),
    by: 'vivid',
    threadId: Option.some(threadId),
  }
  return { ownerActor, memberActor, personalActor, threadId }
})

/** Requests carry no effect claim: the provider's classification is the only source. */
export const toolRequest = (connectionId: ConnectionId, tool: string) => ({
  connectionId,
  tool,
  input: {},
  summary: 'Read the records',
  rationale: 'Answer the question',
})
