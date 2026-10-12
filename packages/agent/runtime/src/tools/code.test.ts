import { describe, expect, it } from '@effect/vitest'
import {
  ApprovalId,
  CodeCall,
  CodeFailure,
  CodeOutcome,
  PersonId,
  ReadPageOutcome,
  ThreadId,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Fiber, Layer, Option, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { codeOutcome, codeTools, pageOutcome } from './code.ts'
import { Scope, toolRunner } from './scope.ts'

const reference = '37e21f26-63ed-4075-aad1-0118929da0ac'

/** Projection keeps provider ids usable and exposes one Approval reference solely for the existing card. */
describe('Program model tools', () => {
  it('projects receipts and errors, preserves provider identifiers and terminates Approval/unknown/rule outcomes', () => {
    const calls = [
      CodeCall.make({ kind: 'use_tool', summary: `Read ${reference}`, end: 'completed' }),
    ]
    const completed = codeOutcome(
      CodeOutcome.cases.Completed.make({
        result: { recordId: reference },
        calls,
        truncated: false,
        logs: [],
        logsTruncated: false,
      }),
    )
    expect(completed.output).toEqual({
      ok: true,
      result: { recordId: reference },
      calls: [{ kind: 'use_tool', summary: 'Read [reference]', end: 'completed' }],
      truncated: false,
      logs: [],
      logsTruncated: false,
    })
    const approval = codeOutcome(
      CodeOutcome.cases.ApprovalRequired.make({
        approvalId: ApprovalId.make(reference),
        summary: 'Send the message',
        calls,
      }),
    )
    expect(approval.terminate).toBe(true)
    expect(approval.output).toMatchObject({
      kind: 'approval-request',
      approvalId: reference,
      summary: 'Send the message',
    })
    for (const outcome of [
      CodeOutcome.cases.Blocked.make({ rule: `Never send ${reference}`, calls }),
      CodeOutcome.cases.OutcomeUnknown.make({ calls }),
    ]) {
      expect(codeOutcome(outcome).terminate).toBe(true)
      expect(JSON.stringify(codeOutcome(outcome).output)).not.toContain(reference)
    }
    const failed = codeOutcome(
      CodeOutcome.cases.Failed.make({
        failure: CodeFailure.cases.Threw.make({ message: `Failed ${reference}` }),
        calls,
        logs: [],
        logsTruncated: false,
      }),
    )
    expect(JSON.stringify(failed.output)).not.toContain(reference)
    const page = pageOutcome(
      ReadPageOutcome.cases.Read.make({
        address: 'https://example.com',
        title: `Page ${reference}`,
        text: `Content ${reference}`,
        truncated: true,
      }),
    )
    expect(JSON.stringify(page.output)).not.toContain(reference)
  })

  it.effect(
    'uses the scoped RPC client without model ownership fields and returns the existing top-level Approval card',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests =
            yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
          const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
            onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
          })
          const scope = Layer.succeed(
            Scope,
            Scope.of({
              acting: {
                personId: PersonId.make('MARK-person'),
                threadId: ThreadId.make('MARK-thread'),
              },
              client: rpc.client,
              folder: Option.none(),
            }),
          )
          const [program, page] = codeTools(toolRunner(scope))
          const context = {
            signal: yield* Effect.abortSignal,
            toolCallId: 'MARK-call',
            log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
          }
          const running = yield* Effect.promise(() =>
            Promise.resolve(
              program.run({ ...context, data: { code: 'return 1;', summary: 'Read the records' } }),
            ),
          ).pipe(Effect.forkScoped)
          const request = yield* Queue.take(requests)
          if (!Predicate.isTagged(request, 'Request'))
            return yield* Effect.die('Expected RPC request')
          expect(request.tag).toBe('RunCode')
          expect(request.payload).toEqual({ code: 'return 1;', summary: 'Read the records' })
          yield* rpc.write({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect RPC protocol envelopes have no constructor in rc.116.
            _tag: 'Exit',
            clientId: 0,
            requestId: request.id,
            exit: Exit.succeed(
              CodeOutcome.cases.ApprovalRequired.make({
                approvalId: ApprovalId.make(reference),
                summary: 'Send mail',
                calls: [],
              }),
            ),
          })
          const result = yield* Fiber.join(running)
          expect(result).toMatchObject({
            output: { kind: 'approval-request', approvalId: reference },
            terminate: true,
          })
          const reading = yield* Effect.promise(() =>
            Promise.resolve(
              page.run({
                ...context,
                data: { summary: 'Public example page', address: 'https://example.com' },
              }),
            ),
          ).pipe(Effect.forkScoped)
          const pageRequest = yield* Queue.take(requests)
          if (!Predicate.isTagged(pageRequest, 'Request'))
            return yield* Effect.die('Expected RPC request')
          expect(pageRequest.tag).toBe('ReadPage')
          expect(pageRequest.payload).toEqual({ address: 'https://example.com' })
          yield* rpc.write({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Effect RPC protocol envelopes have no constructor in rc.116.
            _tag: 'Exit',
            clientId: 0,
            requestId: pageRequest.id,
            exit: Exit.succeed(
              ReadPageOutcome.cases.Refused.make({ reason: 'not a public web address' }),
            ),
          })
          expect(yield* Fiber.join(reading)).toMatchObject({
            output: { ok: false, reason: 'not a public web address' },
          })
          for (const tool of [program, page])
            expect(JSON.stringify(tool.input)).not.toContain('MARK-')
          return yield* Effect.void
        }),
      ),
  )
})
