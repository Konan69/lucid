import { describe, expect, it } from '@effect/vitest'
import {
  AskInputQuestion,
  InputRequest,
  InputRequestId,
  InputRequestState,
  InvalidRequest,
  PersonId,
  PersonSummary,
  ThreadId,
} from '@vivid/contracts'
import { VividRpc } from '@vivid/contracts/rpc'
import { Array as Arr, Effect, Exit, Layer, Predicate, Queue } from 'effect'
import * as RpcClient from 'effect/rpc/RpcClient'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import type * as RpcMessage from 'effect/rpc/RpcMessage'
import * as v from 'valibot'
import { askTools } from './ask.ts'
import { Scope, toolRunner } from './scope.ts'

const one = {
  question: 'Which topics should we review?',
  options: [{ label: 'Research', detail: 'Review sources.' }],
  several: true,
  allowsOwnAnswer: true,
}
const four = [one, { ...one, several: false }, one, one] as const
/** Exercise the actual Flue callback and generated RPC client, controlling only the server receipt. */
describe('ask_person', () => {
  it.effect(
    'asks one or four questions in one RPC, maps selection, and returns all card text',
    () =>
      Effect.gen(function* () {
        const requests =
          yield* Queue.unbounded<RpcMessage.FromClient<RpcGroup.Rpcs<typeof VividRpc>>>()
        const rpc = yield* RpcClient.makeNoSerialization(VividRpc, {
          onFromClient: ({ message }) => Queue.offer(requests, message).pipe(Effect.asVoid),
        })
        const person = PersonSummary.make({
          id: PersonId.make('ask-person'),
          name: 'Ada',
          image: null,
        })
        const threadId = ThreadId.make('ask-thread')
        const scope = Layer.succeed(
          Scope,
          Scope.of({
            acting: { personId: person.id, threadId },
            client: rpc.client,
          }),
        )
        const tool = askTools(toolRunner(scope))[0]
        for (const questions of [[one], four] as const) {
          const data = v.parse(tool.input, { questions })
          const selections =
            questions.length === 1
              ? (['Several'] as const)
              : (['Several', 'One', 'Several', 'Several'] as const)
          const expected = Arr.map(data.questions, (question, index) =>
            AskInputQuestion.make({
              question: question.question,
              options: question.options,
              selection: selections[index] === 'One' ? 'One' : 'Several',
              allowsOwnAnswer: question.allowsOwnAnswer,
            }),
          )
          const input = InputRequest.make({
            id: InputRequestId.make('ask-request'),
            threadId,
            runId: null,
            questions: expected,
            askedOf: person,
            state: InputRequestState.cases.Waiting.make({}),
            createdAt: 1,
          })
          const call = Effect.promise(() =>
            Promise.resolve(
              tool.run({
                data,
                signal: new AbortController().signal,
                toolCallId: 'ask-call',
                log: { info: () => void 0, warn: () => void 0, error: () => void 0 },
              }),
            ),
          )
          /** Reply through the real client after observing its one attributed request. */
          const reply = Effect.fn('Test.Ask.reply')(function* () {
            const request = yield* Queue.take(requests)
            if (!Predicate.isTagged(request, 'Request'))
              return yield* new InvalidRequest({ message: 'Expected an RPC request.' })
            expect(request.tag).toBe('AskInput')
            expect(request.payload).toEqual({ questions: expected })
            return yield* rpc.write({
              // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- The SDK wire envelope has no constructor.
              _tag: 'Exit',
              clientId: 0,
              requestId: request.id,
              exit: Exit.succeed({ request: input }),
            })
          })
          const [result] = yield* Effect.all([call, reply()], { concurrency: 2 })
          expect(result).toMatchObject({
            output: {
              kind: 'input-request',
              requestId: input.id,
              questions: questions.map((question) => question.question),
            },
            terminate: true,
          })
          expect(JSON.stringify(result)).not.toMatch(/ask-person|ask-thread/u)
        }
      }),
  )
})
