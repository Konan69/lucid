import { describe, expect, it } from '@effect/vitest'
import {
  PersonId,
  PersonSummary,
  Skill,
  SkillId,
  SkillScope,
  SkillOrigin,
  SkillSummary,
  ThreadId,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Layer, Option, Predicate, Queue, Schema } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import type * as RpcMessage from 'effect/unstable/rpc/RpcMessage'
import { skillTools } from './skills.ts'
import { Scope, toolRunner } from './scope.ts'

const saveRequest = {
  name: 'Review',
  useWhen: 'Before signing',
  instructions: 'Read the agreement.',
  forCompany: false,
}
const first = Skill.make({
  ...saveRequest,
  id: SkillId.make('MARK-first'),
  scope: SkillScope.cases.Personal.make({}),
  origin: SkillOrigin.cases.Saved.make({
    createdBy: PersonSummary.make({ id: PersonId.make('MARK-person'), name: 'Ada', image: null }),
  }),
  createdAt: 1,
  updatedAt: 10,
})
const second = Skill.make({ ...first, id: SkillId.make('MARK-second'), createdAt: 2, updatedAt: 2 })
/** Summaries are deliberately in reverse update order; immutable creation time fixes duplicate names. */
const summaries = [second, first].map(({ id, name, useWhen, createdAt }) =>
  SkillSummary.make({ id, name, useWhen, createdAt }),
)

const context = {
  toolCallId: 'MARK-call',
  signal: new AbortController().signal,
  log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
}
/** Flue permits several output shapes; assert the actual Vivid runner's JSON receipt at that boundary. */
const decodeOutput = Schema.decodeUnknownEffect(
  Schema.Struct({ output: Schema.Json, terminate: Schema.Boolean }),
)
type RpcExit = RpcMessage.ResponseExit<RpcGroup.Rpcs<typeof VividRpc>>['exit']

/** The real Flue callback and generated RPC client run together; only transport responses are controlled. */
const fixture = Effect.fn('SkillToolsTest.fixture')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
  })
  const layer = Layer.succeed(
    Scope,
    Scope.of({
      acting: { personId: PersonId.make('MARK-person'), threadId: ThreadId.make('MARK-thread') },
      client: rpc.client,
      folder: Option.none(),
    }),
  )
  const [read, save] = skillTools(toolRunner(layer))
  /** Compare server-bound requests while leaving all record references inside this transport seam. */
  const reply = Effect.fn('SkillToolsTest.reply')(function* (
    tag: string,
    payload: Option.Option<Schema.Json>,
    exit: RpcExit,
  ) {
    const request = yield* Queue.take(requests)
    if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected an RPC request')
    expect(request.tag).toBe(tag)
    expect(Option.fromUndefinedOr(request.payload)).toEqual(payload)
    yield* rpc.write({
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
      _tag: 'Exit',
      clientId: 0,
      requestId: request.id,
      exit,
    })
  })
  return {
    requests,
    reply,
    read: (name: string) =>
      Effect.promise(() => Promise.resolve(read.run({ ...context, data: { name } }))).pipe(
        Effect.flatMap(decodeOutput),
      ),
    save: () =>
      Effect.promise(() => Promise.resolve(save.run({ ...context, data: saveRequest }))).pipe(
        Effect.flatMap(decodeOutput),
      ),
  }
})

/** Actual Flue tools use the generated RPC client; only server replies are controlled. */
describe('procedure catalog discovery', () => {
  it.effect('read_skill discovers summaries then fetches only the selected procedure body', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        const respond = Effect.fn('SkillToolsTest.read')(function* () {
          yield* tools.reply(
            'ListSkillSummaries',
            Option.none(),
            Exit.succeed({ skills: summaries }),
          )
          yield* tools.reply(
            'ReadSkill',
            Option.some({ id: second.id }),
            Exit.succeed({ skill: second }),
          )
        })
        const [result] = yield* Effect.all([tools.read('Review (2)'), respond()], {
          concurrency: 2,
        })
        expect(result.output).toMatchObject({
          name: 'Review (2)',
          instructions: saveRequest.instructions,
        })
        expect(yield* Queue.size(tools.requests)).toBe(0)
      }),
    ),
  )

  it.effect('save_skill refreshes summaries and returns the same stable duplicate name', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        const respond = Effect.fn('SkillToolsTest.save')(function* () {
          yield* tools.reply('SaveSkill', Option.some(saveRequest), Exit.succeed({ skill: second }))
          yield* tools.reply(
            'ListSkillSummaries',
            Option.none(),
            Exit.succeed({ skills: summaries }),
          )
        })
        const [result] = yield* Effect.all([tools.save(), respond()], { concurrency: 2 })
        expect(result.output).toEqual({ name: 'Review (2)', useWhen: saveRequest.useWhen })
        expect(yield* Queue.size(tools.requests)).toBe(0)
      }),
    ),
  )
})
