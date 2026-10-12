import { expect, it } from '@effect/vitest'
import {
  NotificationId,
  NotifyPersonOutcome,
  PersonId,
  PushOutcome,
  ThreadId,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Effect, Exit, Layer, Option, Predicate, Queue, Schema } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import { notifyTools } from './notify.ts'
import { Scope, toolRunner } from './scope.ts'

const decodeOutput = Schema.decodeUnknownEffect(
  Schema.Struct({ output: Schema.Json, terminate: Schema.Boolean }),
)
const message = { title: 'Reply overdue', body: 'The agreed reply has not arrived.' }

/** Actual Flue callback and generated RPC client run together; only remote server replies vary. */
it.effect(
  'notify_person distinguishes attempted, present and missing-target delivery without identifiers',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests =
          yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
        const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
          onFromClient: ({ message: envelope }) =>
            Queue.offer(requests, envelope).pipe(Effect.asVoid),
        })
        const layer = Layer.succeed(
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
        const [tool] = notifyTools(toolRunner(layer))
        for (const { push, output } of [
          {
            push: PushOutcome.cases.Attempted.make({ accepted: 2, failed: 1, uncertain: 0 }),
            output: {
              ok: true,
              status: 'attempted',
              acceptedTargets: 2,
              failedTargets: 1,
              uncertainTargets: 0,
            },
          },
          {
            push: PushOutcome.cases.NoTargets.make({}),
            output: {
              ok: true,
              status: 'no-targets',
              acceptedTargets: 0,
              message: expect.stringContaining('No active push target'),
            },
          },
          {
            push: PushOutcome.cases.Present.make({}),
            output: {
              ok: true,
              status: 'present',
              acceptedTargets: 0,
              message: expect.stringContaining('no push was sent'),
            },
          },
        ]) {
          const reply = Effect.fn('NotifyToolsTest.reply')(function* () {
            const request = yield* Queue.take(requests)
            if (!Predicate.isTagged(request, 'Request')) expect.fail('Expected NotifyPerson RPC')
            expect(request.tag).toBe('NotifyPerson')
            expect(request.payload).toEqual(message)
            yield* rpc.write({
              // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- rc.116 protocol envelopes have no constructor.
              _tag: 'Exit',
              clientId: 0,
              requestId: request.id,
              exit: Exit.succeed(
                NotifyPersonOutcome.cases.Created.make({
                  notificationId: NotificationId.make('MARK-notification'),
                  push,
                }),
              ),
            })
          })
          const [result] = yield* Effect.all(
            [
              Effect.promise(() =>
                Promise.resolve(
                  tool.run({
                    data: { summary: 'Overdue reply', title: message.title, body: message.body },
                    toolCallId: 'call',
                    signal: new AbortController().signal,
                    log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
                  }),
                ),
              ).pipe(Effect.flatMap(decodeOutput)),
              reply(),
            ],
            { concurrency: 2 },
          )
          expect(result.output).toMatchObject(output)
          expect(JSON.stringify(result.output)).not.toContain('MARK-')
          expect(result.terminate).toBe(false)
        }
      }),
    ),
)
