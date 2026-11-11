import {
  AddIntegrationOutcome,
  MakeIntegrationOutcome,
  openApiUnsupportedMessage,
  mcpQueryUnsupportedMessage,
  ConnectionMatch,
  ConnectionState,
  ConnectionStep,
  NotFound,
  TestIntegrationOutcome,
  ToolOutcome,
  Workspace,
  type AddIntegrationRequest,
  type MakeIntegrationRequest,
  type FindIntegrationsRequest,
  type TestIntegrationRequest,
} from '@vivid/contracts'
import { Array as Arr, Effect, Option, Order } from 'effect'
import { requireAdmin, type Actor } from '../auth/access.ts'
import { ConnectionAddress, type ConnectionAddressInvalid, publicAddress } from './address.ts'
import { IMPORTED } from './logo.ts'
import { ConnectionStore, ToolDiscovery } from './store.ts'
import { useUnkeyedTool } from './tools.ts'
import { namedAccounts } from './names.ts'
import { stateOf, grantOf, type ConnectionRecord } from './records.ts'
import { testInput } from './probe.ts'
import { madeService, originOf } from './made.ts'

/** A made service is stable by name inside the Person's ownership scope. Ready and failed
 * accounts are reused just like imports; only pending authorization may start another trip. */
export const authorIntegration = Effect.fn('Connections.authorIntegration')(function* (
  actor: Actor,
  request: MakeIntegrationRequest,
) {
  const store = yield* ConnectionStore
  const existing = namedAccounts(yield* store.records(actor)).find(
    ({ row }) =>
      row.personId === actor.person.id &&
      row.companyId === null &&
      row.service === madeService(request.name),
  )
  if (existing !== undefined) {
    const state = yield* stateOf(existing.row)
    return yield* ConnectionState.match<
      Effect.Effect<MakeIntegrationOutcome, Effect.Error<ReturnType<typeof store.resume>>>
    >(state, {
      Ready: () =>
        Effect.succeed(
          MakeIntegrationOutcome.cases.AlreadyConnected.make({
            account: existing.account,
            name: existing.row.serviceName,
          }),
        ),
      Failed: () =>
        Effect.succeed(
          MakeIntegrationOutcome.cases.Failed.make({
            account: existing.account,
            name: existing.row.serviceName,
          }),
        ),
      NeedsAuthorization: () =>
        store.resume(actor, existing.row.id, existing.row.returnsTo).pipe(
          Effect.map((step) =>
            MakeIntegrationOutcome.cases.PendingAuthorization.make({
              account: existing.account,
              step,
            }),
          ),
        ),
    })
  }
  const result = yield* store.make(actor, request).pipe(
    Effect.catchTags({
      ExecutorBuildFailed: ({ message }) =>
        Effect.succeed(MakeIntegrationOutcome.cases.BuildFailed.make({ message })),
      // The store preserves safe setup/declaration diagnostics through InvalidRequest, as
      // add's registration path does. Infrastructure failures remain retryable outcomes.
      InvalidRequest: ({ message }) =>
        Effect.succeed(MakeIntegrationOutcome.cases.NotAnIntegration.make({ reason: message })),
      ServiceUnavailable: () =>
        Effect.succeed(
          MakeIntegrationOutcome.cases.Unreachable.make({
            reason: 'Integrations are unavailable. Try making it again later.',
          }),
        ),
    }),
  )
  if (
    MakeIntegrationOutcome.guards.BuildFailed(result) ||
    MakeIntegrationOutcome.guards.NotAnIntegration(result) ||
    MakeIntegrationOutcome.guards.Unreachable(result)
  )
    return result
  const selected = namedAccounts(yield* store.records(actor)).find(
    ({ row }) => row.id === result.connection.id,
  )
  if (selected === undefined)
    return yield* new NotFound({ message: 'Integration not found after registration' })
  return ConnectionStep.match<MakeIntegrationOutcome>(result, {
    Done: () => MakeIntegrationOutcome.cases.Made.make({ account: selected.account }),
    OpenSignIn: (step) =>
      MakeIntegrationOutcome.cases.PendingAuthorization.make({ account: selected.account, step }),
    EnterKey: (step) =>
      MakeIntegrationOutcome.cases.PendingAuthorization.make({ account: selected.account, step }),
  })
})

/** Match names and descriptions; query words support requests such as “Google calendar”. */
function matches(query: string, name: string, description: string) {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const text = `${name} ${description}`.toLowerCase()
  return words.length === 0 || words.some((word) => text.includes(word))
}

/** Matching accessible accounts lead, then most recently created accounts fill the 24-account
 * bound. Assign labels before sorting to keep discovery names stable. Report omissions so
 * the model can narrow its query; catalogue suggestions remain independently bounded. */
export const findIntegrations = Effect.fn('Connections.findIntegrations')(function* (
  actor: Actor,
  request: FindIntegrationsRequest,
) {
  const store = yield* ConnectionStore
  const records = yield* store.records(actor)
  // An account answers to its whole name and to the address behind a name the Person gave it,
  // so "work" and "ada@example.com" both find "Gmail (Work)".
  const named = namedAccounts(records).map((entry) => ({
    row: entry.row,
    account: entry.account,
    matches: matches(
      request.query,
      entry.row.serviceName,
      [entry.account, ...Option.toArray(Option.fromNullOr(entry.row.identity))].join(' '),
    ),
  }))
  const ordered = Arr.sort(
    named,
    Order.combine(
      Order.mapInput(Order.flip(Order.Boolean), (entry: (typeof named)[number]) => entry.matches),
      Order.mapInput(
        Order.flip(Order.Number),
        (entry: (typeof named)[number]) => entry.row.createdAt,
      ),
    ),
  )
  const accounts = yield* Effect.forEach(
    ordered.slice(0, 24),
    Effect.fn('Connections.accountMatch')(function* ({ row, account }) {
      const state = yield* stateOf(row)
      return ConnectionMatch.cases.Account.make({
        name: row.serviceName,
        account,
        identity: row.identity,
        connected: ConnectionState.guards.Ready(state),
        shared: row.companyId !== null,
        state,
        grant: grantOf(row),
        origin: originOf(row.service),
      })
    }),
  )
  const catalog = yield* store.catalog().pipe(
    Effect.asSome,
    Effect.catchTag('ServiceUnavailable', () => Effect.succeedNone),
  )
  const services = Option.isNone(catalog)
    ? []
    : catalog.value
        .filter((entry) => matches(request.query, entry.name, `${entry.description} ${entry.id}`))
        .slice(0, 24)
        .map((entry) =>
          ConnectionMatch.cases.Catalog.make({
            name: entry.name,
            description: entry.description,
            authorization: entry.authorization,
            connected: records.some((row) => row.service === entry.id && row.status === 'ready'),
          }),
        )
  return {
    integrations: [...accounts, ...services],
    omittedAccounts: Math.max(0, records.length - accounts.length),
    catalog: Option.isSome(catalog) ? ('available' as const) : ('unavailable' as const),
  }
})

/** Match address.ts publicAddress/readMcp and Executor imports: URL serialization folds scheme,
 * host case and default ports; a terminal DNS dot and trailing path slash do not distinguish
 * accounts on the same server. Inspection still dispatches the supplied URL. */
function serverAddress(value: string) {
  return Option.map(Option.fromNullishOr(publicAddress(value)), (address) => {
    address.hostname = address.hostname.replace(/\.$/u, '')
    address.pathname = address.pathname.replace(/\/+$/u, '')
    return address.href
  })
}

/** Legacy duplicates must not hide a usable account. Ready leads pending authorization, then
 * Failed; newest creation wins within each state. Label assignment precedes this one ordering. */
const accountPreference = Order.combine(
  Order.mapInput(Order.Number, (entry: ReturnType<typeof namedAccounts>[number]) => {
    const priority = { ready: 0, 'needs-authorization': 1, failed: 2 }
    return priority[entry.row.status]
  }),
  Order.mapInput(
    Order.flip(Order.Number),
    (entry: ReturnType<typeof namedAccounts>[number]) => entry.row.createdAt,
  ),
)

/** Accessible personal and Company accounts are different ownership scopes. Labels are
 * chosen by the Person and never establish server identity. Catalogue ids lack an address. */
function existingAccount(
  records: readonly ConnectionRecord[],
  actor: Actor,
  request: AddIntegrationRequest,
  requestedAddress: string,
) {
  const companyId = Workspace.match(actor.workspace, {
    Personal: () => Option.none(),
    Company: ({ company }) => Option.some(company.id),
  })
  return Option.flatMap(serverAddress(requestedAddress), (address) =>
    Option.fromNullishOr(
      Arr.sort(namedAccounts(records), accountPreference).find(({ row }) => {
        const sameOwner = request.shared
          ? Option.contains(companyId, row.companyId)
          : row.companyId === null && row.personId === actor.person.id
        if (!sameOwner || !row.service.startsWith(IMPORTED)) return false
        if (request.another && row.status !== 'failed') return false
        return Option.contains(serverAddress(row.service.slice(IMPORTED.length)), address)
      }),
    ),
  )
}

/** Pending authorization retains its resources. A failed personal account has no working
 * authorization: asking again in chat replaces it through ordinary removal, not a duplicate.
 * Shared accounts remain under their existing management authority. None continues registration. */
const reuseAccount = Effect.fn('Connections.reuseAccount')(function* (
  actor: Actor,
  existing: ReturnType<typeof namedAccounts>[number],
) {
  const state = yield* stateOf(existing.row)
  return yield* ConnectionState.match<
    Effect.Effect<
      Option.Option<AddIntegrationOutcome>,
      Effect.Error<
        | ReturnType<typeof ConnectionStore.Service.resume>
        | ReturnType<typeof ConnectionStore.Service.remove>
      >,
      ConnectionStore | Effect.Services<ReturnType<typeof ConnectionStore.Service.remove>>
    >
  >(state, {
    Ready: () =>
      Effect.succeedSome(
        AddIntegrationOutcome.cases.AlreadyConnected.make({
          account: existing.account,
          name: existing.row.serviceName,
        }),
      ),
    Failed: ({ reason }) =>
      Effect.gen(function* () {
        if (existing.row.companyId !== null || existing.row.personId !== actor.person.id)
          return Option.some(
            AddIntegrationOutcome.cases.Failed.make({
              account: existing.account,
              name: existing.row.serviceName,
              reason,
            }),
          )
        yield* (yield* ConnectionStore).remove(actor, existing.row.id)
        return Option.none()
      }),
    // A Run may reissue only its acting Person's grant. Company visibility is not permission
    // to transfer someone else's pending sign-in through the Person-only resume operation.
    NeedsAuthorization: () =>
      Effect.gen(function* () {
        if (existing.row.personId !== actor.person.id)
          return Option.some(
            AddIntegrationOutcome.cases.AwaitingInitiator.make({
              name: existing.row.serviceName,
            }),
          )
        // A Run has no new client surface; retain the destination of the last client trip.
        const step = yield* (yield* ConnectionStore).resume(
          actor,
          existing.row.id,
          existing.row.returnsTo,
        )
        return Option.some(
          AddIntegrationOutcome.cases.PendingAuthorization.make({
            account: existing.account,
            step,
          }),
        )
      }),
  })
})

/** Only inspection and new registration classify import failures. In particular, resume's
 * InvalidRequest retains its original domain meaning instead of becoming an unsupported URL. */
const inspectionFailures = {
  ExecutorImportQueryUnsupported: () =>
    Effect.succeed(
      AddIntegrationOutcome.cases.NotAnIntegration.make({ reason: mcpQueryUnsupportedMessage }),
    ),
  ExecutorSourceUnsupported: () =>
    Effect.succeed(
      AddIntegrationOutcome.cases.NotAnIntegration.make({ reason: openApiUnsupportedMessage }),
    ),
  ConnectionAddressInvalid: ({ reason }: ConnectionAddressInvalid) =>
    Effect.succeed(AddIntegrationOutcome.cases.NotAnIntegration.make({ reason })),
  ConnectionAddressUnreachable: () =>
    Effect.succeed(
      AddIntegrationOutcome.cases.Unreachable.make({ reason: 'could not be reached' }),
    ),
}

/** Registration refusals describe a new import, never a failure resuming an existing grant. */
const registrationFailures = {
  ExecutorPublicAddressRequired: () =>
    Effect.succeed(
      AddIntegrationOutcome.cases.Unreachable.make({
        reason: 'this Vivid is not set up to add a server by address yet',
      }),
    ),
  ServiceUnavailable: () =>
    Effect.succeed(
      AddIntegrationOutcome.cases.Unreachable.make({ reason: 'could not be reached' }),
    ),
  InvalidRequest: () =>
    Effect.succeed(
      AddIntegrationOutcome.cases.NotAnIntegration.make({
        reason: 'unsupported integration authorization or specification',
      }),
    ),
}

/** A Run reuses the requested ownership before importing an address.
 * Only the Person-only completion endpoint accepts secrets for a new Integration. */
export const addIntegration = Effect.fn('Connections.addIntegration')(function* (
  actor: Actor,
  request: AddIntegrationRequest,
) {
  if (request.shared) yield* requireAdmin(actor.workspace)
  const store = yield* ConnectionStore
  const records = yield* store.records(actor)
  const existing = existingAccount(records, actor, request, request.address)
  if (Option.isSome(existing)) {
    const reused = yield* reuseAccount(actor, existing.value)
    if (Option.isSome(reused)) return reused.value
  }
  const source = yield* (yield* ConnectionAddress)
    .inspect(request.address)
    .pipe(Effect.catchTags(inspectionFailures))
  if (
    AddIntegrationOutcome.guards.NotAnIntegration(source) ||
    AddIntegrationOutcome.guards.Unreachable(source)
  )
    return source
  // inspectAddress follows redirects; imports persist source.address, never the supplied alias.
  const resolved = existingAccount(yield* store.records(actor), actor, request, source.address)
  if (Option.isSome(resolved)) {
    const reused = yield* reuseAccount(actor, resolved.value)
    if (Option.isSome(reused)) return reused.value
  }
  const step = yield* store.add(actor, request, source).pipe(Effect.catchTags(registrationFailures))
  if (
    AddIntegrationOutcome.guards.NotAnIntegration(step) ||
    AddIntegrationOutcome.guards.Unreachable(step)
  )
    return step
  const selected = Option.fromNullishOr(
    namedAccounts(yield* store.records(actor)).find((entry) => entry.row.id === step.connection.id),
  )
  if (Option.isNone(selected))
    return yield* new NotFound({ message: 'Integration not found after registration' })
  return ConnectionStep.match<AddIntegrationOutcome>(step, {
    Done: () => AddIntegrationOutcome.cases.Added.make({ account: selected.value.account }),
    OpenSignIn: (value) => AddIntegrationOutcome.cases.NeedsSignIn.make({ step: value }),
    EnterKey: (value) => AddIntegrationOutcome.cases.NeedsKey.make({ step: value }),
  })
})

/** Testing never returns provider data, which can include private records or echoed credentials.
 * Every dispatch goes through the ordinary Gate, including personal reads in shared Threads.
 */
export const testIntegration = Effect.fn('Connections.testIntegration')(
  function* (actor: Actor, request: TestIntegrationRequest) {
    const store = yield* ConnectionStore
    const selected = namedAccounts(yield* store.records(actor)).find(
      (entry) => entry.account.trim().toLowerCase() === request.account.trim().toLowerCase(),
    )
    if (selected === undefined) return yield* new NotFound({ message: 'Integration not found' })
    const { row, account } = selected
    const state = yield* stateOf(row)
    const refusal = ConnectionState.match<Option.Option<TestIntegrationOutcome>>(state, {
      Failed: () =>
        Option.some(
          TestIntegrationOutcome.cases.NotTested.make({
            account,
            tools: [],
            reason: 'integration failed',
          }),
        ),
      NeedsAuthorization: () =>
        Option.some(
          TestIntegrationOutcome.cases.NotTested.make({
            account,
            tools: [],
            reason: 'needs sign-in',
          }),
        ),
      Ready: () => Option.none(),
    })
    if (Option.isSome(refusal)) return refusal.value
    const discovery = yield* store.tools(actor, row)
    if (ToolDiscovery.guards.NeedsAuthorization(discovery))
      return TestIntegrationOutcome.cases.NotTested.make({
        account,
        tools: [],
        reason: 'needs sign-in',
      })
    const tools = ToolDiscovery.match(discovery, {
      Ready: ({ tools: catalog }) => catalog,
      NeedsAuthorization: () => [],
      Failed: () => [],
    })
    const visible = tools.filter((tool) => row.companyId === null || tool.effect === 'read')
    const names = visible.map((tool) => tool.name)
    // Read-only is Executor/provider metadata, not a behavioral proof. An empty optional-input
    // list/search can still read private records; the response is discarded and the Person sees
    // the exact called tool. Gate still decides whether this read may cross the Thread boundary.
    const candidates = visible.flatMap((tool) => {
      if (tool.effect !== 'read') return []
      return Option.toArray(Option.map(testInput(tool.input), (input) => ({ tool, input })))
    })
    const selectedProbe =
      candidates.find((candidate) =>
        /(?:^|[._])(?:ping|health|status|me|myself|whoami)(?:$|[._])/iu.test(candidate.tool.name),
      ) ?? candidates[0]
    if (selectedProbe === undefined)
      return TestIntegrationOutcome.cases.NotTested.make({
        account,
        tools: names,
        reason: 'no read-only tool can be tested without extra input',
      })
    const { tool, input } = selectedProbe
    const outcome = yield* useUnkeyedTool(actor, {
      connectionId: row.id,
      tool: tool.name,
      input,
      summary: `Test the ${account} integration`,
      rationale: 'Confirm the integration works with one read-only call.',
    })
    return testedOutcome(account, names, tool.name, outcome.outcome)
  },
  (effect) =>
    effect.pipe(
      Effect.catchTags({
        ServiceUnavailable: () => Effect.succeed(TestIntegrationOutcome.cases.Unreachable.make({})),
        // The test call is a read and reads are never journaled, so this refusal cannot be met
        // here; it is still answered as a call that did not run rather than left to the caller.
        ActionReconciliationRequired: () =>
          Effect.succeed(TestIntegrationOutcome.cases.Unreachable.make({})),
      }),
    ),
)

/** Project every Integration result without reporting an unanswered form as a successful test. */
function testedOutcome(
  account: string,
  names: readonly string[],
  tool: string,
  outcome: ToolOutcome,
) {
  return ToolOutcome.match<TestIntegrationOutcome>(outcome, {
    Accepted: () =>
      TestIntegrationOutcome.cases.NotTested.make({
        account,
        tools: names,
        reason: 'result not confirmed',
      }),
    Completed: () =>
      TestIntegrationOutcome.cases.Tested.make({ account, tools: names, tool: tool }),
    // The test call is a read, which the journal never answers in place of sending.
    Repeated: () => TestIntegrationOutcome.cases.Tested.make({ account, tools: names, tool: tool }),
    InputRequired: () =>
      TestIntegrationOutcome.cases.NotTested.make({
        account,
        tools: names,
        reason: 'result not confirmed',
      }),
    ApprovalRequired: ({ approvalId, summary }) =>
      TestIntegrationOutcome.cases.ApprovalRequired.make({ approvalId, summary }),
    Blocked: ({ rule }) => TestIntegrationOutcome.cases.Blocked.make({ rule }),
    ScopeRequired: () =>
      TestIntegrationOutcome.cases.Refused.make({
        account,
        tools: names,
        tool: tool,
        message: 'additional access required',
      }),
    PermissionDeclined: () =>
      TestIntegrationOutcome.cases.Refused.make({
        account,
        tools: names,
        tool: tool,
        message: 'data permission declined',
      }),
    Unsupported: () =>
      TestIntegrationOutcome.cases.Refused.make({
        account,
        tools: names,
        tool: tool,
        message: 'capability unsupported',
      }),
    ConnectionNotReady: () =>
      TestIntegrationOutcome.cases.NotTested.make({
        account,
        tools: names,
        reason: 'needs sign-in',
      }),
    Rejected: ({ message }) =>
      TestIntegrationOutcome.cases.Refused.make({
        account,
        tools: names,
        tool: tool,
        message,
      }),
    OutcomeUnknown: () =>
      TestIntegrationOutcome.cases.NotTested.make({
        account,
        tools: names,
        reason: 'call failed',
      }),
  })
}
