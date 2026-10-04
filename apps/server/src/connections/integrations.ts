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
  type AddIntegrationRequest,
  type FindIntegrationsRequest,
  type TestIntegrationRequest,
} from '@vivid/contracts'
import { Effect, Option } from 'effect'
import { requireAdmin, type Actor } from '../auth/access.ts'
import { ConnectionAddress, publicAddress } from './address.ts'
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

/** Up to 24 accessible accounts in stable creation order precede query-matched catalogue
 * suggestions (also capped at 24), even for unrelated queries or an offline catalogue.
 * Account names are assigned before the bound so discovery labels stay stable.
 * Provider slugs retain names such as Google for Gmail without exposing identifiers to the model.
 * Authorization stays explicit: a catalogue listing alone never promises a working sign-in. */
export const findIntegrations = Effect.fn('Connections.findIntegrations')(function* (
  actor: Actor,
  request: FindIntegrationsRequest,
) {
  const store = yield* ConnectionStore
  const records = yield* store.records(actor)
  const accounts = yield* Effect.forEach(
    namedAccounts(records).slice(0, 24),
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
    catalog: Option.isSome(catalog) ? ('available' as const) : ('unavailable' as const),
  }
})

/** Reuse only the acting Person's ready account: exact canonical imported address wins, then
 * an exact service name (case/edge-space insensitive). Account labels are not service identity.
 * Catalogue Connections do not persist their endpoint, so their authoritative service name is
 * the available match. No network probe or installation is needed to use an existing account. */
function existingAccount(records: readonly ConnectionRecord[], request: AddIntegrationRequest) {
  const ready = namedAccounts(records).filter(
    ({ row }) => row.companyId === null && row.status === 'ready',
  )
  const address = publicAddress(request.address)
  const byAddress =
    address === undefined
      ? undefined
      : ready.find(({ row }) => row.service === `url:${address.href}`)
  if (byAddress !== undefined) return byAddress
  const name = request.name.trim().toLowerCase()
  return ready.find(({ row }) => row.serviceName.trim().toLowerCase() === name)
}

/** A Run reuses a ready personal Integration before inspecting or importing an address.
 * Only the Person-only completion endpoint accepts secrets for a new Integration. */
export const addIntegration = Effect.fn('Connections.addIntegration')(
  function* (actor: Actor, request: AddIntegrationRequest) {
    if (request.shared) yield* requireAdmin(actor.workspace)
    const store = yield* ConnectionStore
    const existing = existingAccount(yield* store.records(actor), request)
    if (existing !== undefined)
      return AddIntegrationOutcome.cases.AlreadyConnected.make({ account: existing.account })
    const source = yield* (yield* ConnectionAddress).inspect(request.address)
    const step = yield* store.add(actor, request, source)
    const selected = namedAccounts(yield* store.records(actor)).find(
      (entry) => entry.row.id === step.connection.id,
    )
    if (selected === undefined)
      return yield* Effect.fail(
        new NotFound({ message: 'Integration not found after registration' }),
      )
    return ConnectionStep.match<AddIntegrationOutcome>(step, {
      Done: () => AddIntegrationOutcome.cases.Added.make({ account: selected.account }),
      OpenSignIn: (value) => AddIntegrationOutcome.cases.NeedsSignIn.make({ step: value }),
      EnterKey: (value) => AddIntegrationOutcome.cases.NeedsKey.make({ step: value }),
    })
  },
  (effect) =>
    effect.pipe(
      Effect.catchTags({
        ExecutorImportQueryUnsupported: () =>
          Effect.succeed(
            AddIntegrationOutcome.cases.NotAnIntegration.make({
              reason: mcpQueryUnsupportedMessage,
            }),
          ),
        ExecutorSourceUnsupported: () =>
          Effect.succeed(
            AddIntegrationOutcome.cases.NotAnIntegration.make({
              reason: openApiUnsupportedMessage,
            }),
          ),
        ExecutorPublicAddressRequired: () =>
          Effect.succeed(
            AddIntegrationOutcome.cases.Unreachable.make({
              reason: 'this Vivid is not set up to add a server by address yet',
            }),
          ),
        ConnectionAddressInvalid: ({ reason }) =>
          Effect.succeed(AddIntegrationOutcome.cases.NotAnIntegration.make({ reason })),
        ConnectionAddressUnreachable: () =>
          Effect.succeed(
            AddIntegrationOutcome.cases.Unreachable.make({ reason: 'could not be reached' }),
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
      }),
    ),
)

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
