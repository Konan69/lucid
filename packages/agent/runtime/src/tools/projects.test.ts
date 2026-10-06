import { describe, expect, it } from '@effect/vitest'
import { PersonId, Project, ProjectId, ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Layer, Option, Predicate, Queue, Schema } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import type * as RpcMessage from 'effect/unstable/rpc/RpcMessage'
import { projectTools } from './projects.ts'
import { Scope, toolRunner } from './scope.ts'

const context = {
  toolCallId: 'PRIVATE-call',
  signal: new AbortController().signal,
  log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
}
const decodeOutput = Schema.decodeUnknownEffect(
  Schema.Struct({ output: Schema.Json, terminate: Schema.Boolean }),
)
type RpcExit = RpcMessage.ResponseExit<RpcGroup.Rpcs<typeof VividRpc>>['exit']

/** Real Flue callbacks send generated RPC requests; only the server reply is controlled. */
const fixture = Effect.fn('ProjectToolsTest.fixture')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
  })
  const scope = Layer.succeed(
    Scope,
    Scope.of({
      acting: {
        personId: PersonId.make('PRIVATE-person'),
        threadId: ThreadId.make('PRIVATE-thread'),
      },
      client: rpc.client,
      folder: Option.none(),
    }),
  )
  const [create] = projectTools(toolRunner(scope))
  /** Observe typed protocol requests rather than replacing the product client method. */
  const reply = Effect.fn('ProjectToolsTest.reply')(function* (
    tag: string,
    payload: Schema.Json,
    exit: RpcExit,
  ) {
    const request = yield* Queue.take(requests)
    if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected an RPC request')
    expect(request.tag).toBe(tag)
    expect(request.payload === undefined ? null : request.payload).toEqual(payload)
    yield* rpc.write({
      // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- rc.116 has no SDK envelope constructor.
      _tag: 'Exit',
      clientId: 0,
      requestId: request.id,
      exit,
    })
  })
  return {
    create: (data: Parameters<typeof create.run>[0]['data']) =>
      Effect.promise(() => Promise.resolve(create.run({ ...context, data }))).pipe(
        Effect.flatMap(decodeOutput),
      ),
    reply,
    requests,
  }
})

/** Server-owned attribution and identifiers must never become model-visible metadata. */
const project = (name: string, parentProjectId: ProjectId | null) =>
  Project.make({
    id: ProjectId.make('PRIVATE-project'),
    companyId: null,
    name,
    parentProjectId,
    createdBy: PersonId.make('PRIVATE-person'),
    threadCount: 0,
    updatedAt: 0,
  })

describe('Project tools', () => {
  it.effect(
    'creates a top-level Project and reports the server-confirmed name without identifiers',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tools = yield* fixture()
          const [result] = yield* Effect.all(
            [
              tools.create({
                summary: 'Launch work',
                name: 'Launch',
                location: { kind: 'TopLevel' },
              }),
              tools.reply(
                'CreateProject',
                { name: 'Launch', parentProjectId: null },
                Exit.succeed(project('Launch', null)),
              ),
            ],
            { concurrency: 2 },
          )
          expect(result.output).toEqual({
            ok: true,
            name: 'Launch',
            parent: null,
            message: 'Created the Project. Threads have not been moved.',
          })
          expect(JSON.stringify(result)).not.toContain('PRIVATE-')
        }),
      ),
  )

  it.effect('resolves an exact parent from the visible Project list before creating', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* fixture()
        const parent = project('Launch', null)
        const [result] = yield* Effect.all(
          [
            tools.create({
              summary: 'Launch work',
              name: 'Website',
              location: { kind: 'Within', project: 'Launch' },
            }),
            Effect.gen(function* () {
              yield* tools.reply('ListProjects', null, Exit.succeed({ projects: [parent] }))
              yield* tools.reply(
                'CreateProject',
                { name: 'Website', parentProjectId: parent.id },
                Exit.succeed(project('Website', parent.id)),
              )
            }),
          ],
          { concurrency: 2 },
        )
        expect(result.output).toMatchObject({ ok: true, name: 'Website', parent: 'Launch' })
        expect(JSON.stringify(result)).not.toContain('PRIVATE-')
      }),
    ),
  )

  for (const parents of [[], [project('Launch', null), project('Launch', null)]]) {
    it.effect(
      parents.length === 0
        ? 'missing parent refuses creation'
        : 'ambiguous parent refuses creation',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const tools = yield* fixture()
            const [result] = yield* Effect.all(
              [
                tools.create({
                  summary: 'Launch work',
                  name: 'Website',
                  location: { kind: 'Within', project: 'Launch' },
                }),
                tools.reply('ListProjects', null, Exit.succeed({ projects: parents })),
              ],
              { concurrency: 2 },
            )
            expect(result.output).toHaveProperty('ok', false)
            expect(yield* Queue.size(tools.requests)).toBe(0)
          }),
        ),
    )
  }
})
