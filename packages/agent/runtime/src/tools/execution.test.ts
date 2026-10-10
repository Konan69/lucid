import { describe, expect, it } from '@effect/vitest'
import { Effect, Exit, Layer, Option, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import {
  InvalidRequest,
  LibraryFolderId,
  LibraryItemId,
  PersonId,
  ThreadId,
  ComputerShellOutcome,
  ComputerFileReadOutcome,
  ComputerFileWriteOutcome,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { libraryTools } from './library.ts'
import { Scope, scopeLayer, scopedRunner, toolRunner } from './scope.ts'
import { computerSandbox } from './sandbox.ts'

const reference = 'f3323d18-a15e-44ea-8555-3d23e1634ccd'

/** Exercise the actual Flue callback, Scope Layer, generated RPC client and final model result together. */
describe('scoped tool execution', () => {
  it.effect('preserves every Computer refusal message at the Flue sandbox boundary', () =>
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
            personId: PersonId.make('sandbox-person'),
            threadId: ThreadId.make('sandbox-thread'),
          },
          client: rpc.client,
          folder: Option.none(),
        }),
      )
      const sandbox = computerSandbox(scopedRunner(scope), '/home/user')
      const reason = 'The Computer is held by its Person.\nWait.'
      const path = '/home/user/report.txt'
      // Exercise the public sandbox and real RPC client, with only server receipts controlled.
      const cases = [
        {
          call: () => sandbox.exec('true'),
          tag: 'ComputerShell',
          outcome: ComputerShellOutcome.cases.Unavailable.make({ reason }),
          message: reason,
        },
        {
          call: () => sandbox.exec('true'),
          tag: 'ComputerShell',
          outcome: ComputerShellOutcome.cases.OutcomeUnknown.make({}),
          message:
            'The connection to the Computer was lost while the command ran. It may have run: check before running it again.',
        },
        {
          call: () => sandbox.readFile(path),
          tag: 'ComputerFileRead',
          outcome: ComputerFileReadOutcome.cases.Refused.make({ reason }),
          message: `${path}: ${reason}`,
        },
        {
          call: () => sandbox.readFile(path),
          tag: 'ComputerFileRead',
          outcome: ComputerFileReadOutcome.cases.Unavailable.make({ reason }),
          message: reason,
        },
        {
          call: () => sandbox.writeFile(path, 'report'),
          tag: 'ComputerFileWrite',
          outcome: ComputerFileWriteOutcome.cases.Refused.make({ reason }),
          message: `${path}: ${reason}`,
        },
        {
          call: () => sandbox.writeFile(path, 'report'),
          tag: 'ComputerFileWrite',
          outcome: ComputerFileWriteOutcome.cases.Unavailable.make({ reason }),
          message: reason,
        },
      ]
      for (const scenario of cases) {
        const call = Effect.promise(() =>
          expect(scenario.call()).rejects.toEqual(new Error(scenario.message)),
        )
        // Reply to every attempt Flue makes while exercising this scenario's sandbox call.
        const answer = Effect.fn('Test.Computer.reply')(function* () {
          // Flue's writeFileCreatingParents retries a failed write after a mkdir command.
          const attempts = scenario.tag === 'ComputerFileWrite' ? 3 : 1
          for (let attempt = 0; attempt < attempts; attempt++) {
            const request = yield* Queue.take(requests)
            if (!Predicate.isTagged(request, 'Request'))
              return yield* new InvalidRequest({ message: 'Expected an RPC request.' })
            expect(request.tag).toBe(attempt === 1 ? 'ComputerShell' : scenario.tag)
            const outcome =
              attempt === 1
                ? ComputerShellOutcome.cases.Completed.make({
                    stdout: '',
                    stderr: '',
                    exitCode: 0,
                    timedOut: false,
                    truncated: false,
                  })
                : scenario.outcome
            // RpcMessage.ResponseExit has no constructor in rc.116; this is the SDK wire envelope.
            yield* rpc.write({
              // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
              _tag: 'Exit',
              clientId: 0,
              requestId: request.id,
              exit: Exit.succeed(outcome),
            })
          }
          return undefined
        })
        yield* Effect.all([call, answer()], { concurrency: 2 })
      }
      // A tagged authority failure is still converted to the same generic Flue Error.
      const absent = scopeLayer('absent-thread', { kind: 'user', body: 'Read.' }, Option.none())
      yield* Effect.promise(() =>
        expect(scopedRunner(absent)(Effect.void, Option.none())).rejects.toEqual(
          new Error('The Computer could not be reached. Try again.'),
        ),
      )
    }),
  )

  it.effect('injects the Routine folder automatically without returning Library references', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const folder of [
          Option.none<LibraryFolderId>(),
          Option.some(LibraryFolderId.make(reference)),
        ]) {
          const requests =
            yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
          const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
            // The controlled transport records generated requests; the real client owns RPC behavior.
            onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
          })
          const layer = Layer.succeed(
            Scope,
            Scope.of({
              acting: {
                personId: PersonId.make('MARK-person'),
                threadId: ThreadId.make('MARK-thread'),
              },
              client: rpc.client,
              folder,
            }),
          )
          const [search] = libraryTools(toolRunner(layer))
          // Flue logging is not part of model output, and this read-only tool emits no progress logs.
          const call = Effect.promise(() =>
            Promise.resolve(
              search.run({
                data: { summary: 'Agreement sources', query: 'Agreement', limit: 6 },
                toolCallId: 'MARK-call',
                signal: new AbortController().signal,
                log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
              }),
            ),
          )
          const answer = Effect.fn('Test.Library.reply')(function* () {
            const request = yield* Queue.take(requests)
            if (!Predicate.isTagged(request, 'Request'))
              return yield* new InvalidRequest({ message: 'Expected an RPC request.' })
            expect(request.tag).toBe('SearchLibrary')
            const expected = Option.match(folder, {
              onNone: () => ({ query: 'Agreement', limit: 6 }),
              onSome: (folderId) => ({ query: 'Agreement', limit: 6, folderId }),
            })
            expect(request.payload).toEqual(expected)
            // RpcMessage.ResponseExit has no constructor in rc.116; this is the SDK wire envelope.
            return yield* rpc.write({
              // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- SDK protocol envelopes have no constructor in rc.116.
              _tag: 'Exit',
              clientId: 0,
              requestId: request.id,
              exit: Exit.succeed({
                results: [
                  {
                    chunkId: 'MARK-chunk',
                    documentId: LibraryItemId.make(reference),
                    filename: 'Agreement.pdf',
                    page: 1,
                    text: 'Signed.',
                    score: 1,
                  },
                ],
              }),
            })
          })
          const [result] = yield* Effect.all([call, answer()], { concurrency: 2 })
          expect(result).toEqual({
            output: {
              results: [
                {
                  filename: 'Agreement.pdf',
                  page: 1,
                  text: 'Signed.',
                  citation: '[Agreement.pdf, p.1]',
                },
              ],
            },
            terminate: false,
          })
          expect(JSON.stringify(result)).not.toMatch(
            /MARK-|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu,
          )
        }
      }),
    ),
  )
})
