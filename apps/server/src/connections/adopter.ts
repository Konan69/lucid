import { Context, Effect, Layer, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import {
  ExecutorAppOwnership,
  AdoptedSource,
  AdoptionGroupId,
  ExecutorAccessDenied,
  ExecutorConflict,
  ExecutorRateLimited,
  ExecutorResponseInvalid,
  ExecutorTransportFailure,
  executorAddress,
  ExecutorAppId,
  ExecutorAccountId,
  type ExecutorActiveReferences,
} from './executor.ts'
import { requiredSetting, settingSecret } from '../config.ts'

const Group = Schema.Struct({ id: AdoptionGroupId, revision: Schema.String })
const Groups = Schema.Struct({ groups: Schema.Array(Group) })
const ManagedResources = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ app: Schema.Struct({ id: ExecutorAppId }) })),
  accounts: Schema.Array(Schema.Struct({ account: Schema.Struct({ id: ExecutorAccountId }) })),
})
const context = { service: 'connections' as const, tool: null }

/** Only installation-authorized management of adopted resources lives here. Execution stays in
 * Executor.as(member); these keys never become a fallback for a refused member invocation. */
const makeTransport = Effect.fn('Adopter.transport')(function* () {
  const { url, organization } = yield* executorAddress()
  const key = yield* requiredSetting('VIVID_EXECUTOR_KEY', settingSecret, 'the Executor API key')
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  const base = `${url}/api/organizations/${encodeURIComponent(organization)}`
  /** Validate each public API answer; transport and policy failures never expose foreign payloads. */
  const exchange = <A, I>(schema: Schema.Codec<A, I>) =>
    Effect.fn('Adopter.exchange')(
      function* (
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        body: Schema.Json,
      ) {
        let request = HttpClientRequest.make(method)(base + path).pipe(
          HttpClientRequest.bearerToken(key),
        )
        if (method !== 'GET')
          request = yield* HttpClientRequest.bodyJson(request, body).pipe(
            Effect.mapError(() => ExecutorResponseInvalid.make(context)),
          )
        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError(() => ExecutorTransportFailure.make(context)))
        // A missing exact link is already unlinked; app/account absence is checked through managed resources.
        if (response.status === 404 && method === 'DELETE')
          return yield* Schema.decodeUnknownEffect(schema)(null).pipe(
            Effect.mapError(() => ExecutorResponseInvalid.make(context)),
          )
        if (response.status === 429) return yield* ExecutorRateLimited.make(context)
        if (response.status === 409) return yield* ExecutorConflict.make(context)
        if (response.status >= 500) return yield* ExecutorTransportFailure.make(context)
        if (response.status < 200 || response.status >= 300)
          return yield* ExecutorAccessDenied.make(context)
        return yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError(() => ExecutorResponseInvalid.make(context)),
        )
      },
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: '30 seconds',
        orElse: () => Effect.fail(ExecutorTransportFailure.make(context)),
      }),
    )
  return { exchange }
})
type Transport = Effect.Success<ReturnType<typeof makeTransport>>

/** Reclamation knows exact owned links; it never lists user links as a non-user. */
function removeAdopted(transport: Transport) {
  /** Adopted apps have an owner-created personal account. Unlink both known requirements
   * without user-link listing, which the owner cannot read after its use grant is removed. */
  return Effect.fn('Adopter.remove')(function* (references: ExecutorActiveReferences) {
    const ownership = references.appOwnership
    if (!ExecutorAppOwnership.guards.Adopted(ownership))
      return yield* ExecutorAccessDenied.make(context)
    const source = ownership.source
    const inventory = yield* transport.exchange(ManagedResources)(
      'GET',
      '/resources?view=managed',
      {},
    )
    const present = inventory.apps.some((entry) => entry.app.id === references.app)
    const app = encodeURIComponent(references.app)
    if (present && AdoptedSource.guards.Account(source)) {
      const account = encodeURIComponent(source.account)
      for (const [scope, requirement] of [
        ['user', source.original],
        ['app', source.adopted],
      ] as const)
        yield* transport.exchange(Schema.Json)(
          'DELETE',
          `/apps/${app}/accounts/${scope}/${encodeURIComponent(requirement)}/${account}`,
          {},
        )
    }
    if (present) yield* transport.exchange(Schema.Json)('DELETE', `/apps/${app}`, {})
    if (
      AdoptedSource.guards.Account(source) &&
      inventory.accounts.some((entry) => entry.account.id === source.account)
    )
      yield* transport.exchange(Schema.Json)(
        'DELETE',
        `/accounts/${encodeURIComponent(source.account)}`,
        {},
      )
  })
}

/** Retain owner authority for deleting adopted apps, accounts and their access groups. */
const makeAdopter = Effect.fn('Adopter.make')(function* () {
  const transport = yield* makeTransport()
  const groups = () => transport.exchange(Groups)('GET', '/groups', {})
  return {
    remove: removeAdopted(transport),
    /** Retrying removal after a lost reply finds no group and completes without another write. */
    removeGroup: Effect.fn('Adopter.removeGroup')(function* (id: typeof AdoptionGroupId.Type) {
      const found = (yield* groups()).groups.find((entry) => entry.id === id)
      if (found !== undefined)
        yield* transport.exchange(Schema.Json)('DELETE', `/groups/${encodeURIComponent(id)}`, {
          revision: found.revision,
        })
    }),
  }
})

export class ExecutorAdoption extends Context.Service<
  ExecutorAdoption,
  Effect.Success<ReturnType<typeof makeAdopter>>
>()('vivid/ExecutorAdoption') {}
export const executorAdoptionLayer = Layer.effect(ExecutorAdoption, makeAdopter())
