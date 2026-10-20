import { describe, expect, it } from '@effect/vitest'
import { ReadDocumentOutcome, NotFound, PersonId, ThreadId } from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Layer, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import * as v from 'valibot'
import { documentTools, read, written } from './documents.ts'
import { settle } from './result.ts'
import { Scope, toolRunner, type RunTool } from './scope.ts'

const reference = '37e21f26-63ed-4075-aad1-0118929da0ac'
/** Definition inspection must never perform I/O. */
const unavailable: RunTool = () => Promise.reject(new Error('Schema inspection cannot execute'))
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
    }),
  )
  return { requests, rpc, runTool: toolRunner(scope) }
})

describe('document tools', () => {
  it('bounds complete Markdown, preserves whitespace, and rejects model ownership or turn fields', () => {
    const [write, reading] = documentTools(unavailable)
    const valid = {
      summary: 'Launch plan',
      title: 'Plan',
      body: '# Plan\n\n  keep indentation',
      note: 'Added a date',
    }
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
    expect(v.safeParse(reading.input, { summary: 'Launch plan', title: 'Plan' }).success).toBe(true)
    expect(
      v.safeParse(reading.input, { summary: 'Launch plan', title: 'Plan', id: reference }).success,
    ).toBe(false)
  })

  it('projects creation, revision, Markdown and Missing titles in human words without references', () => {
    expect(written({ title: 'Plan', version: 1, created: true, changed: true })).toMatchObject({
      ok: true,
      title: 'Plan',
      version: 1,
      created: true,
      changed: true,
      message: 'Wrote the document.',
    })
    expect(written({ title: 'Plan', version: 2, created: false, changed: true })).toMatchObject({
      ok: true,
      version: 2,
      created: false,
      changed: true,
      message: 'Revised the document.',
    })
    expect(written({ title: 'Plan', version: 2, created: false, changed: false })).toMatchObject({
      ok: true,
      version: 2,
      changed: false,
      message: 'The document is unchanged.',
    })
    expect(
      read(
        ReadDocumentOutcome.cases.Found.make({
          title: 'Plan',
          version: 2,
          body: '# Plan\n\nNext step.',
        }),
      ),
    ).toEqual({ ok: true, title: 'Plan', version: 2, body: '# Plan\n\nNext step.', characters: 18 })
    expect(
      read(ReadDocumentOutcome.cases.Missing.make({ titles: ['Plan', 'Report'] })),
    ).toMatchObject({ ok: false, titles: ['Plan', 'Report'] })
    expect(
      read(
        ReadDocumentOutcome.cases.Found.make({
          title: reference,
          version: 1,
          body: `Document ${reference}`,
        }),
      ),
    ).toEqual({
      ok: true,
      title: '[reference]',
      version: 1,
      body: 'Document [reference]',
      characters: 45,
    })
  })

  it.effect('sends only document fields for WriteDocument and only title for ReadDocument', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { requests, rpc, runTool } = yield* fixture()
        const [write, reading] = documentTools(runTool)
        const writing = yield* Effect.promise(() =>
          Promise.resolve(
            write.run({
              ...context,
              data: {
                summary: 'Launch plan',
                title: 'Plan',
                body: '# Plan',
                note: 'Changed scope',
              },
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
        })
        yield* rpc.write({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect RPC envelopes have no constructor in rc.116.
          _tag: 'Exit',
          clientId: 0,
          requestId: request.id,
          exit: Exit.succeed({ title: 'Plan', version: 2, created: false, changed: true }),
        })
        expect(yield* Fiber.join(writing)).toMatchObject({
          output: { ok: true, title: 'Plan', version: 2, created: false, changed: true },
        })
        const running = yield* Effect.promise(() =>
          Promise.resolve(
            reading.run({ ...context, data: { summary: 'Launch plan', title: 'Missing' } }),
          ),
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

  it.effect('reports server-side missing working Run through the ordinary safe failure view', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { requests, rpc, runTool } = yield* fixture()
        const [write] = documentTools(runTool)
        const writing = yield* Effect.promise(() =>
          Promise.resolve(
            write.run({
              ...context,
              data: { summary: 'Launch plan', title: 'Plan', body: '# Plan' },
            }),
          ),
        ).pipe(Effect.forkScoped)
        const request = yield* Queue.take(requests)
        if (!Predicate.isTagged(request, 'Request'))
          return yield* Effect.die('Expected RPC request')
        yield* rpc.write({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect RPC envelopes have no constructor in rc.116.
          _tag: 'Exit',
          clientId: 0,
          requestId: request.id,
          exit: Exit.fail(new NotFound({ message: 'Working Run not found' })),
        })
        expect(yield* Fiber.join(writing)).toMatchObject({
          output: { ok: false, message: 'It does not exist or the person cannot see it.' },
        })
        return yield* Effect.void
      }),
    ),
  )

  it.effect(
    'preserves document bodies through 48,000 characters while other tools keep their bound',
    () =>
      Effect.gen(function* () {
        for (const length of [4_001, 48_000]) {
          const body = 'word '.repeat(Math.ceil(length / 5)).slice(0, length)
          const output = read(
            ReadDocumentOutcome.cases.Found.make({
              title: 'Plan',
              version: 1,
              body,
            }),
          )
          expect((yield* settle(Effect.succeed({ output }), 'read_document')).output).toEqual({
            ok: true,
            title: 'Plan',
            version: 1,
            body,
            characters: length,
          })
        }
        const output = read(
          ReadDocumentOutcome.cases.Found.make({
            title: 'Plan',
            version: 1,
            body: 'word '.repeat(9_600),
          }),
        )
        expect((yield* settle(Effect.succeed({ output }), 'read_page')).output).toMatchObject({
          body: 'word '.repeat(800),
          truncated: true,
        })
      }),
  )

  it.effect(
    'reports the stored body’s full count when references in a long read are redacted',
    () =>
      Effect.gen(function* () {
        const body = `${reference}\n${'word '.repeat(9_601)}`
        const output = read(
          ReadDocumentOutcome.cases.Found.make({ title: 'Plan', version: 1, body }),
        )
        const result = (yield* settle(Effect.succeed({ output }), 'read_document')).output
        expect(result).toMatchObject({
          body: ('[reference]\n' + 'word '.repeat(9_601)).slice(0, 48_000),
          truncated: true,
          characters: body.length,
        })
        expect(JSON.stringify(result)).toContain(
          `This document has ${body.length} characters in all.`,
        )
        expect(JSON.stringify(result)).not.toContain(reference)
      }),
  )

  it.effect('marks cut document reads with the total character count in plain words', () =>
    Effect.gen(function* () {
      for (const length of [48_001, 200_000]) {
        const output = read(
          ReadDocumentOutcome.cases.Found.make({
            title: 'Plan',
            version: 2,
            body: 'word '.repeat(Math.ceil(length / 5)).slice(0, length),
          }),
        )
        expect((yield* settle(Effect.succeed({ output }), 'read_document')).output).toEqual({
          ok: true,
          title: 'Plan',
          version: 2,
          body: 'word '.repeat(9_600),
          truncated: true,
          characters: length,
          message: `This document has ${length} characters in all. Only the first 48,000 characters are shown; this is not the whole document.`,
        })
      }
    }),
  )
})
