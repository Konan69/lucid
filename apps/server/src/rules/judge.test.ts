import { expect, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import {
  ActionTarget,
  ConnectionId,
  PersonId,
  PersonSummary,
  ProposedAction,
  Rule,
  RuleId,
  RuleScope,
} from '@vivid/contracts'
import { RuleJudge, RulesNotJudged, ruleJudgeLayer } from './judge.ts'

interface RequestsService {
  readonly values: Ref.Ref<ReadonlyArray<HttpClientRequest.HttpClientRequest>>
}
class Requests extends Context.Service<Requests, RequestsService>()('vivid/JudgeTestRequests') {}

/** A transport port supplies controlled replies; the production judge still builds and decodes HTTP. */
const transport = (status: number, body: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const values = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([])
      const client = HttpClient.make((request) =>
        Ref.update(values, (requests) => requests.concat([request])).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
        ),
      )
      return Context.make(Requests, { values }).pipe(Context.add(HttpClient.HttpClient, client))
    }),
  )

/** Provider credentials are test-only and stay in the redacted configuration/HTTP authority. */
const judgeLayer = (status: number, body: string, config: Readonly<Record<string, string>>) =>
  ruleJudgeLayer.pipe(
    Layer.provideMerge(transport(status, body)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
  )

const rule = Rule.make({
  id: RuleId.make('rule-one'),
  action: 'Update work records',
  decision: 'Ask',
  scope: RuleScope.cases.Personal.make({}),
  createdBy: PersonSummary.make({ id: PersonId.make('person-one'), name: 'Ada', image: null }),
  createdAt: 1,
})
const action = ProposedAction.make({
  summary: 'Update work record',
  rationale: 'PRIVATE_RATIONALE',
  effect: 'write',
  target: ActionTarget.cases.Connection.make({
    connectionId: ConnectionId.make('connection-one'),
    account: 'PRIVATE_ACCOUNT',
    tool: 'PRIVATE_TOOL',
    input: { private: 'PRIVATE_INPUT' },
  }),
})
const config = { OPENROUTER_API_KEY: 'test-provider-key' }
const reply = (ids: ReadonlyArray<string>) =>
  JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ids }) } }] })
const Body = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
  response_format: Schema.Json,
})
const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Body))

it.effect(
  'one completion returns applicable rules without leaking target values or rationale',
  () =>
    Effect.gen(function* () {
      const result = yield* (yield* RuleJudge).judge(action, [rule])
      expect(result).toEqual([rule])
      const requests = yield* Ref.get((yield* Requests).values)
      expect(requests).toHaveLength(1)
      const first = requests[0]
      expect(first).toBeDefined()
      if (first === undefined) return
      const web = yield* HttpClientRequest.toWeb(first)
      const json = yield* Effect.tryPromise(() => web.text())
      const body = yield* decodeBody(json)
      expect(body.model).toBe('z-ai/glm-5.3-flash')
      const prompt = body.messages.map((message) => message.content).join('\n')
      expect(prompt).toContain(action.summary)
      expect(prompt).toContain(rule.action)
      for (const privateValue of [
        'PRIVATE_INPUT',
        'PRIVATE_RATIONALE',
        'PRIVATE_ACCOUNT',
        'PRIVATE_TOOL',
        config.OPENROUTER_API_KEY,
      ])
        expect(prompt).not.toContain(privateValue)
    }).pipe(Effect.provide(judgeLayer(200, reply([rule.id]), config))),
)

it.effect('no rules needs neither a provider key nor a completion', () =>
  Effect.gen(function* () {
    expect(yield* (yield* RuleJudge).judge(action, [])).toEqual([])
    expect(yield* Ref.get((yield* Requests).values)).toEqual([])
  }).pipe(Effect.provide(judgeLayer(200, reply([]), {}))),
)

it.effect('a missing provider key fails closed without calling HTTP', () =>
  Effect.gen(function* () {
    const result = yield* Effect.result((yield* RuleJudge).judge(action, [rule]))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(RulesNotJudged)
    expect(yield* Ref.get((yield* Requests).values)).toEqual([])
  }).pipe(Effect.provide(judgeLayer(200, reply([]), {}))),
)

/** A provider failure, malformed JSON or invented id must not silently become an Allow judgment. */
it.effect.each([
  [429, reply([])],
  [500, reply([])],
  [200, 'invalid JSON'],
  [200, reply(['unknown-rule'])],
  [200, JSON.stringify({ choices: [] })],
] as const)('fails closed for status %s and invalid reply', ([status, body]) =>
  Effect.gen(function* () {
    const result = yield* Effect.result((yield* RuleJudge).judge(action, [rule]))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(RulesNotJudged)
    expect(yield* Ref.get((yield* Requests).values)).toHaveLength(1)
  }).pipe(Effect.provide(judgeLayer(status, body, config))),
)
