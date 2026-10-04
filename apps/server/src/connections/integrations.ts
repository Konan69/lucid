import {
  AddIntegrationOutcome,
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
  type FindIntegrationsRequest,
  type TestIntegrationRequest,
} from '@vivid/contracts'
import { Array as Arr, Effect, Option, Order } from 'effect'
import { requireAdmin, type Actor } from '../auth/access.ts'
import { ConnectionAddress, type ConnectionAddressInvalid, publicAddress } from './address.ts'
import { IMPORTED } from './logo.ts'
import { ConnectionStore } from './store.ts'
import { namedAccounts, useTool } from './tools.ts'
import { stateOf, type ConnectionRecord } from './records.ts'
import { testInput } from './probe.ts'

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
  const named = namedAccounts(records).map((entry) => ({
    row: entry.row,
    account: entry.account,
    matches: matches(request.query, entry.row.serviceName, entry.account),
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
        connected: ConnectionState.guards.Ready(state),
        shared: row.companyId !== null,
        state,
      })
    }),
  )
  const catalog = yield* store.catalog().pipe(
    Effect.map(Option.some),
    Effect.catchTag('ServiceUnavailable', () => Effect.succeed(Option.none())),
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
 * host case and default ports; a terminal DNS dot names the same host. Preserve the exact path
 * (including its trailing slash), query and scheme because inspection dispatches that URL and
 * imports persist it. Redirect equivalence is checked separately after inspection. */
function serverAddress(value: string) {
  return Option.map(Option.fromNullishOr(publicAddress(value)), (address) => {
    address.hostname = address.hostname.replace(/\.$/u, '')
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
        return Option.contains(serverAddress(row.service.slice(IMPORTED.length)), address)
      }),
    ),
  )
}

/** Pending authorization resumes the existing provider resources and row. Failed resources
 * must be removed explicitly; another Add must never silently allocate a duplicate account. */
const reuseAccount = Effect.fn('Connections.reuseAccount')(function* (
  actor: Actor,
  existing: ReturnType<typeof namedAccounts>[number],
) {
  const state = yield* stateOf(existing.row)
  return yield* ConnectionState.match<
    Effect.Effect<
      AddIntegrationOutcome,
      Effect.Error<ReturnType<typeof ConnectionStore.Service.resume>>,
      ConnectionStore
    >
  >(state, {
    Ready: () =>
      Effect.succeed(
        AddIntegrationOutcome.cases.AlreadyConnected.make({
          account: existing.account,
          name: existing.row.serviceName,
        }),
      ),
    Failed: () =>
      Effect.succeed(
        AddIntegrationOutcome.cases.Failed.make({
          account: existing.account,
          name: existing.row.serviceName,
        }),
      ),
    // A Run may reissue only its acting Person's grant. Company visibility is not permission
    // to transfer someone else's pending sign-in through the Person-only resume operation.
    NeedsAuthorization: () =>
      Effect.gen(function* () {
        if (existing.row.personId !== actor.person.id)
          return AddIntegrationOutcome.cases.AwaitingInitiator.make({
            name: existing.row.serviceName,
          })
        const step = yield* (yield* ConnectionStore).resume(actor, existing.row.id)
        return AddIntegrationOutcome.cases.PendingAuthorization.make({
          account: existing.account,
          step,
        })
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
  if (Option.isSome(existing)) return yield* reuseAccount(actor, existing.value)
  const source = yield* (yield* ConnectionAddress)
    .inspect(request.address)
    .pipe(Effect.catchTags(inspectionFailures))
  if (
    AddIntegrationOutcome.guards.NotAnIntegration(source) ||
    AddIntegrationOutcome.guards.Unreachable(source)
  )
    return source
  // inspectAddress follows redirects; imports persist source.address, never the supplied alias.
  const resolved = existingAccount(records, actor, request, source.address)
  if (Option.isSome(resolved)) return yield* reuseAccount(actor, resolved.value)
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
    return yield* Effect.fail(new NotFound({ message: 'Integration not found after registration' }))
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
    if (selected === undefined)
      return yield* Effect.fail(new NotFound({ message: 'Integration not found' }))
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
    const tools = yield* store.tools(actor, row)
    const visible = tools.filter((tool) => row.companyId === null || tool.effect === 'read')
    const names = visible.map((tool) => tool.name)
    // Read-only is Executor/provider metadata, not a behavioral proof. An empty optional-input
    // list/search can still read private records; the response is discarded and the Person sees
    // the exact called tool. Gate still decides whether this read may cross the Thread boundary.
    const candidates = visible.flatMap((tool) => {
      if (tool.effect !== 'read') return []
      return Option.toArray(
        Option.map(testInput(tool.input, row.references), (input) => ({ tool, input })),
      )
    })
    const selectedProbe =
      candidates.find((candidate) =>
        /(?:^|[._])(?:ping|health|status|me)(?:$|[._])/iu.test(candidate.tool.name),
      ) ?? candidates[0]
    if (selectedProbe === undefined)
      return TestIntegrationOutcome.cases.NotTested.make({
        account,
        tools: names,
        reason: 'no read-only tool can be tested without extra input',
      })
    const { tool, input } = selectedProbe
    const outcome = yield* useTool(actor, {
      connectionId: row.id,
      tool: tool.name,
      input,
      summary: `Test the ${account} integration`,
      rationale: 'Confirm the integration works with one read-only call.',
    })
    return ToolOutcome.match<TestIntegrationOutcome>(outcome, {
      Completed: () =>
        TestIntegrationOutcome.cases.Tested.make({ account, tools: names, tool: tool.name }),
      ApprovalRequired: ({ approvalId, summary }) =>
        TestIntegrationOutcome.cases.ApprovalRequired.make({ approvalId, summary }),
      Blocked: ({ rule }) => TestIntegrationOutcome.cases.Blocked.make({ rule }),
      ConnectionNotReady: () =>
        TestIntegrationOutcome.cases.NotTested.make({
          account,
          tools: names,
          reason: 'needs sign-in',
        }),
      Rejected: () =>
        TestIntegrationOutcome.cases.NotTested.make({
          account,
          tools: names,
          reason: 'call failed',
        }),
      OutcomeUnknown: () =>
        TestIntegrationOutcome.cases.NotTested.make({
          account,
          tools: names,
          reason: 'call failed',
        }),
    })
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag('ServiceUnavailable', () =>
        Effect.succeed(TestIntegrationOutcome.cases.Unreachable.make({})),
      ),
    ),
)
