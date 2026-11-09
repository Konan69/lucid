import { Config, Context, Effect, Layer, Schema } from 'effect'
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

/** A missing directory relation cannot improve within this boot without a configuration change. */
export class AdoptionMemberMissing extends Schema.TaggedError<AdoptionMemberMissing>()(
  'AdoptionMemberMissing',
  {},
  { title: 'Executor adoption member missing' },
) {}
export class AdoptionOwnerMissing extends Schema.TaggedError<AdoptionOwnerMissing>()(
  'AdoptionOwnerMissing',
  {},
  { title: 'Executor adoption owner missing' },
) {}

const Group = Schema.Struct({
  id: AdoptionGroupId,
  revision: Schema.String,
  name: Schema.String,
  description: Schema.String,
  memberIds: Schema.Array(Schema.String),
})
const Groups = Schema.Struct({
  groups: Schema.Array(Group),
  members: Schema.Array(
    Schema.Struct({ id: Schema.String, userId: Schema.String, email: Schema.String }),
  ),
})
const ManagedResources = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ app: Schema.Struct({ id: ExecutorAppId }) })),
  accounts: Schema.Array(Schema.Struct({ account: Schema.Struct({ id: ExecutorAccountId }) })),
})
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
})
const Access = Schema.Struct({ revision: Schema.String })
const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) })
const context = { service: 'connections' as const, tool: null }

/** Only installation-authorized adoption and management calls live here. Execution stays in
 * Executor.as(member); these keys never become a fallback for a refused member invocation. */
const makeTransport = Effect.fn('Adopter.transport')(function* () {
  const { url, organization } = yield* executorAddress()
  const key = yield* requiredSetting('VIVID_EXECUTOR_KEY', settingSecret, 'the Executor API key')
  const email = yield* Config.String('VIVID_EXECUTOR_OWNER_EMAIL')
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
  return { exchange, email }
})
type Transport = Effect.Success<ReturnType<typeof makeTransport>>

/** Exact group membership is repaired from the public organization directory. */
function groupManager(transport: Transport) {
  /** The group name is derived from the Connection id. Repeating a step repairs exact membership. */
  return Effect.fn('Adopter.group')(function* (name: string, user: string, staged: boolean) {
    const inventory = yield* transport.exchange(Groups)('GET', '/groups', {})
    const member = inventory.members.find((entry) => entry.userId === user)
    const owner = inventory.members.find((entry) => entry.email === transport.email)
    if (member === undefined) return yield* AdoptionMemberMissing.make({})
    if (owner === undefined) return yield* AdoptionOwnerMissing.make({})
    const memberIds = staged ? [member.id, owner.id] : [member.id]
    const existing = inventory.groups.find((entry) => entry.name === name)
    const body = { name, description: 'Vivid Integration adoption', memberIds }
    if (existing === undefined) return yield* transport.exchange(Group)('POST', '/groups', body)
    if (
      existing.memberIds.length === memberIds.length &&
      memberIds.every((id) => existing.memberIds.includes(id))
    )
      return existing
    return yield* transport.exchange(Group)('PATCH', `/groups/${encodeURIComponent(existing.id)}`, {
      ...body,
      revision: existing.revision,
    })
  })
}

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

/** Acquire installation authority once; calls and Watches use a separate member transport. */
const makeAdopter = Effect.fn('Adopter.make')(function* () {
  const transport = yield* makeTransport()
  const groups = () => transport.exchange(Groups)('GET', '/groups', {})
  const audience = Effect.fn('Adopter.audience')(function* (
    app: typeof ExecutorAppId.Type,
    group: typeof AdoptionGroupId.Type,
  ) {
    const path = `/apps/${encodeURIComponent(app)}/access`
    const access = yield* transport.exchange(Access)('GET', path, {})
    yield* transport.exchange(Access)('PATCH', path, {
      revision: access.revision,
      audience: { kind: 'groups', groups: [group] },
    })
  })
  return {
    group: groupManager(transport),
    probe: groups().pipe(Effect.asVoid),
    /** Absence is checked through owner management visibility, including partly retired requests. */
    apps: transport
      .exchange(ManagedResources)('GET', '/resources?view=managed', {})
      .pipe(Effect.map((resources) => resources.apps.map((entry) => entry.app.id))),
    remove: removeAdopted(transport),
    audience,
    /** The original app id keeps app SQL data, event names and existing Watch identities intact. */
    source: (app: typeof ExecutorAppId.Type) =>
      transport
        .exchange(Source)('GET', `/apps/${encodeURIComponent(app)}/source`, {})
        .pipe(Effect.map((source) => source.files)),
    deploy: (app: typeof ExecutorAppId.Type, files: typeof Source.Type.files) =>
      transport
        .exchange(Deployed)('POST', `/apps/${encodeURIComponent(app)}/deploy`, { files })
        .pipe(Effect.asVoid),
    link: (
      app: typeof ExecutorAppId.Type,
      requirement: string,
      account: typeof ExecutorAccountId.Type,
    ) =>
      transport
        .exchange(Schema.Json)(
          'PUT',
          `/apps/${encodeURIComponent(app)}/accounts/app/${encodeURIComponent(requirement)}/${encodeURIComponent(account)}`,
          {},
        )
        .pipe(Effect.asVoid),
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
