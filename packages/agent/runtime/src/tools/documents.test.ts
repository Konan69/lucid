import { describe, expect, it } from '@effect/vitest'
import { ReadDocumentOutcome, PersonId, ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Layer, Option, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/unstable/rpc/RpcClient'
import type * as RpcGroup from 'effect/unstable/rpc/RpcGroup'
import type * as RpcMessage from 'effect/unstable/rpc/RpcMessage'
import * as v from 'valibot'
import { documentTools, read, written } from './documents.ts'
import { Scope, toolRunner, type RunTool } from './scope.ts'

const reference = '37e21f26-63ed-4075-aad1-0118929da0ac'
/** Definition inspection must never perform I/O. */
const unavailable: RunTool = () => Promise.reject(new Error('Schema inspection cannot execute'))
const delivery = {
  kind: 'signal',
  type: 'message',
  body: 'Keep a plan',
  attributes: { turn: '7' },
} as const
const context = {
  signal: new AbortController().signal,
  toolCallId: 'document-call',
  log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
}

/** A real schema-derived RPC client captures the actual wire payload, without mocking the tool seam. */
const fixture = Effect.fn('Documents.test.fixture')(function* () {
  const requests = yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
  const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
    onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
  })
  const scope = Layer.succeed(
    Scope,
    Scope.of({
      acting: {
        personId: PersonId.make('document-person'),
        threadId: ThreadId.make('document-thread'),
      },
      client: rpc.client,
      folder: Option.none(),
    }),
  )
  return { requests, rpc, runTool: toolRunner(scope) }
})

describe('document tools', () => {
  it('bounds complete Markdown, preserves whitespace, and rejects model ownership or turn fields', () => {
    const [write, reading] = documentTools(unavailable, delivery)
    const valid = { title: 'Plan', body: '# Plan\n\n  keep indentation', note: 'Added a date' }
    expect(v.parse(write.input, valid)).toEqual(valid)
    for (const input of [
      { ...valid, title: '' },
      { ...valid, title: 'a'.repeat(121) },
      { ...valid, body: ' ' },
      { ...valid, body: 'a'.repeat(200_001) },
      { ...valid, note: '' },
      { ...valid, note: 'a'.repeat(201) },
      { ...valid, turn: 1 },
      { ...valid, threadId: reference },
      { ...valid, runId: reference },
    ])
      expect(v.safeParse(write.input, input).success).toBe(false)
    expect(v.safeParse(reading.input, { title: 'Plan' }).success).toBe(true)
    expect(v.safeParse(reading.input, { title: 'Plan', id: reference }).success).toBe(false)
  })

  it('projects creation, revision, Markdown and Missing titles in human words without references', () => {
    expect(written({ title: 'Plan', version: 1, created: true })).toMatchObject({
      ok: true,
      title: 'Plan',
      version: 1,
      created: true,
    })
    expect(written({ title: 'Plan', version: 2, created: false })).toMatchObject({
      ok: true,
      version: 2,
      created: false,
    })
    expect(
      read(
        ReadDocumentOutcome.cases.Found.make({
          title: 'Plan',
          version: 2,
          body: '# Plan\n\nNext step.',
        }),
      ),
    ).toEqual({ ok: true, title: 'Plan', version: 2, body: '# Plan\n\nNext step.' })
    expect(
      read(ReadDocumentOutcome.cases.Missing.make({ titles: ['Plan', 'Report'] })),
    ).toMatchObject({ ok: false, titles: ['Plan', 'Report'] })
    expect(
      JSON.stringify(
        read(
          ReadDocumentOutcome.cases.Found.make({
            title: reference,
            version: 1,
            body: `Document ${reference}`,
          }),
        ),
      ),
    ).not.toContain(reference)
  })

  it.effect(
    'injects the render delivery turn into WriteDocument and sends only title for ReadDocument',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { requests, rpc, runTool } = yield* fixture()
          const [write, reading] = documentTools(runTool, delivery)
          const writing = yield* Effect.promise(() =>
            Promise.resolve(
              write.run({
                ...context,
                data: { title: 'Plan', body: '# Plan', note: 'Changed scope' },
              }),
            ),
          ).pipe(Effect.forkScoped)
          const request = yield* Queue.take(requests)
          if (!Predicate.isTagged(request, 'Request'))
            return yield* Effect.die('Expected RPC request')
          expect(request.tag).toBe('WriteDocument')
          expect(request.payload).toEqual({
            title: 'Plan',
            body: '# Plan',
            note: 'Changed scope',
            turn: 7,
          })
          yield* rpc.write({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect RPC envelopes have no constructor in rc.116.
            _tag: 'Exit',
            clientId: 0,
            requestId: request.id,
            exit: Exit.succeed({ title: 'Plan', version: 2, created: false }),
          })
          expect(yield* Fiber.join(writing)).toMatchObject({
            output: { ok: true, title: 'Plan', version: 2, created: false },
          })
          const running = yield* Effect.promise(() =>
            Promise.resolve(reading.run({ ...context, data: { title: 'Missing' } })),
          ).pipe(Effect.forkScoped)
          const readRequest = yield* Queue.take(requests)
          if (!Predicate.isTagged(readRequest, 'Request'))
            return yield* Effect.die('Expected RPC request')
          expect(readRequest.tag).toBe('ReadDocument')
          expect(readRequest.payload).toEqual({ title: 'Missing' })
          yield* rpc.write({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect RPC envelopes have no constructor in rc.116.
            _tag: 'Exit',
            clientId: 0,
            requestId: readRequest.id,
            exit: Exit.succeed(ReadDocumentOutcome.cases.Missing.make({ titles: ['Plan'] })),
          })
          expect(yield* Fiber.join(running)).toMatchObject({
            output: { ok: false, titles: ['Plan'] },
          })
          return yield* Effect.void
        }),
      ),
  )

  it.effect('refuses a missing or invalid delivery turn before making an RPC write', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runTool } = yield* fixture()
        for (const current of [
          { kind: 'user', body: 'Write' } as const,
          { ...delivery, attributes: { turn: 'no' } },
          { ...delivery, attributes: { turn: '1.5' } },
        ]) {
          const [write] = documentTools(runTool, current)
          const result = yield* Effect.promise(() =>
            Promise.resolve(write.run({ ...context, data: { title: 'Plan', body: 'No write' } })),
          )
          expect(result).toMatchObject({ output: { ok: false } })
        }
      }),
    ),
  )
})
