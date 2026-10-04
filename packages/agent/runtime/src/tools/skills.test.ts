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
import { BuiltinSkillActivationRequired, BuiltinSkillNameReserved, skillTools } from './skills.ts'
import { Scope, toolRunner } from './scope.ts'

const encodeActivation = Schema.encodeSync(BuiltinSkillActivationRequired)
const encodeReserved = Schema.encodeSync(BuiltinSkillNameReserved)

const saveRequest = {
  name: 'review',
  about: 'Reviews your agreement before you sign.',
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
const summaries = [
  second,
  first,
  {
    id: SkillId.make('builtin:deep-research'),
    name: 'Deep research',
    useWhen: 'When research needs sources',
    createdAt: 0,
  },
].map(({ id, name, useWhen, createdAt }) => SkillSummary.make({ id, name, useWhen, createdAt }))

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
      Effect.promise(() =>
        Promise.resolve(
          read.run({ ...context, data: { summary: 'Agreement review steps', name } }),
        ),
      ).pipe(Effect.flatMap(decodeOutput)),
    save: (name: string) =>
      Effect.promise(() =>
        Promise.resolve(
          save.run({
            ...context,
            data: { summary: 'Save the agreement review steps', ...saveRequest, name },
          }),
        ),
      ).pipe(Effect.flatMap(decodeOutput)),
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
        const [result] = yield* Effect.all([tools.read('review-2'), respond()], {
          concurrency: 2,
        })
        expect(result.output).toMatchObject({
          name: 'review-2',
          instructions: saveRequest.instructions,
        })
        expect(yield* Queue.size(tools.requests)).toBe(0)
      }),
    ),
  )

  it.effect(
    'read_skill redirects either built-in name form to native activation without an RPC',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* fixture()
          for (const name of ['Deep research', 'deep-research', ' DEEP RESEARCH ']) {
            const result = yield* tools.read(name)
            expect(result.output).toEqual({
              ok: false,
              error: encodeActivation(
                new BuiltinSkillActivationRequired({
                  runtimeName: 'deep-research',
                  tool: 'activate_skill',
                }),
              ),
              message: 'Use activate_skill with deep-research.',
            })
          }
          expect(yield* Queue.size(tools.requests)).toBe(0)
        }),
      ),
  )

  it.effect('save_skill refuses runtime and display names before any write', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        for (const name of ['deep-research', 'Deep research', ' DEEP RESEARCH ']) {
          const result = yield* tools.save(name)
          expect(result.output).toMatchObject({
            ok: false,
            error: encodeReserved(
              new BuiltinSkillNameReserved({
                runtimeName: 'deep-research',
                message: 'that name belongs to a built-in skill; choose another name',
              }),
            ),
            message: 'that name belongs to a built-in skill; choose another name',
          })
          expect(JSON.stringify(result.output)).not.toContain('builtin:')
        }
        expect(yield* Queue.size(tools.requests)).toBe(0)
      }),
    ),
  )

  it.effect(
    'read_skill keeps a legacy collision readable only under a distinct saved runtime name',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* fixture()
          const legacy = Skill.make({
            ...first,
            name: 'Deep research',
            instructions: 'Use our reviewed method.',
          })
          const respond = Effect.fn('SkillToolsTest.legacy')(function* () {
            yield* tools.reply(
              'ListSkillSummaries',
              Option.none(),
              Exit.succeed({ skills: [legacy] }),
            )
            yield* tools.reply(
              'ReadSkill',
              Option.some({ id: legacy.id }),
              Exit.succeed({ skill: legacy }),
            )
          })
          const [result] = yield* Effect.all([tools.read('deep-research-saved'), respond()], {
            concurrency: 2,
          })
          expect(result.output).toEqual({
            name: 'deep-research-saved',
            useWhen: legacy.useWhen,
            instructions: legacy.instructions,
            source: 'Saved procedure',
          })
          expect(JSON.stringify(result.output)).not.toContain(legacy.id)
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
        const [result] = yield* Effect.all([tools.save(saveRequest.name), respond()], {
          concurrency: 2,
        })
        expect(result.output).toEqual({ name: 'review-2', useWhen: saveRequest.useWhen })
        expect(yield* Queue.size(tools.requests)).toBe(0)
      }),
    ),
  )
})
