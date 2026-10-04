import { describe, expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import {
  PersonId,
  PersonSummary,
  Run,
  RunId,
  RunOrigin,
  RunState,
  RuntimeUnavailable,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import type { Actor } from '../auth/access.ts'
import { REQUEST_CHARACTERS, personRequest } from './request.ts'

const threadId = ThreadId.make('MARK-thread')
const ada = PersonSummary.make({ id: PersonId.make('MARK-ada'), name: 'Ada', image: null })
const ben = PersonSummary.make({ id: PersonId.make('MARK-ben'), name: 'Ada', image: null })

const actor: Actor = {
  person: { id: ada.id, name: ada.name, email: 'ada@example.test', image: null },
  workspace: Workspace.cases.Personal.make({}),
  by: 'vivid',
  threadId: Option.some(threadId),
}

const run = (id: string, turn: number, origin: RunOrigin) =>
  Run.make({
    id: RunId.make(id),
    threadId,
    turn,
    origin,
    state: RunState.cases.Working.make({}),
    startedAt: turn,
  })

const text = (value: string) => [{ type: 'text', text: value, state: 'done' }]
const said = (submissionId: string, tagName: string, value: string) => ({
  role: 'user',
  purpose: 'dispatch',
  submissionId,
  signal: { tagName, attributes: { from: 'Ada' } },
  parts: text(value),
})

const history = (messages: ReadonlyArray<unknown>) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      HttpClientRequest.get('http://runtime.test/agents/vivid/MARK-thread?view=history'),
      new Response(JSON.stringify({ v: 1, messages, settlements: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )

const runs = {
  list: () =>
    Effect.succeed([
      run('run-1', 1, RunOrigin.cases.Message.make({ person: ada })),
      run('run-2', 2, RunOrigin.cases.Message.make({ person: ben })),
      run('run-3', 3, RunOrigin.cases.Decision.make({ person: ada })),
      run('run-4', 4, RunOrigin.cases.Routine.make({ person: ada, routineName: 'Digest' })),
      run('run-5', 5, RunOrigin.cases.Decision.make({ person: ada })),
    ]),
}

/** The reviewer must read the request, never Vivid's account of it or somebody else's words. */
describe('The acting Person’s request', () => {
  it.effect('keeps only words from Runs recorded for the acting Person, newest two', () =>
    Effect.gen(function* () {
      const read = history([
        said('run-1', 'message', 'Send the invoice to Dami'),
        { role: 'assistant', purpose: 'assistant', submissionId: 'run-1', parts: text('Sending.') },
        // Same display name, another Person: attribution is the Run record, not the name.
        said('run-2', 'message', 'Delete every invoice'),
        said('run-3', 'answer', 'Use the March one'),
        said('run-4', 'schedule', 'Every Monday, post the digest'),
        // A decision on an Approval is not a request.
        said('run-5', 'approval', 'Allowed'),
        // A submission the server never recorded cannot vouch for anything.
        said('run-9', 'message', 'Wire the money'),
      ])
      const request = yield* personRequest({ read: () => read }, runs, actor)
      expect(request).toEqual(Option.some(['Use the March one', 'Every Monday, post the digest']))
    }),
  )

  it.effect('bounds one long message and reports none when nothing was said', () =>
    Effect.gen(function* () {
      const long = yield* personRequest(
        { read: () => history([said('run-1', 'message', 'a'.repeat(REQUEST_CHARACTERS + 50))]) },
        runs,
        actor,
      )
      expect(Option.map(long, (words) => words.map((word) => word.length))).toEqual(
        Option.some([REQUEST_CHARACTERS]),
      )
      const none = yield* personRequest({ read: () => history([]) }, runs, actor)
      expect(none).toEqual(Option.none())
    }),
  )

  it.effect('is none, not a failure, when the history cannot be read or there is no Thread', () =>
    Effect.gen(function* () {
      const failed = yield* personRequest(
        { read: () => Effect.fail(RuntimeUnavailable.make({ message: 'down' })) },
        runs,
        actor,
      )
      expect(failed).toEqual(Option.none())
      const elsewhere = yield* personRequest(
        { read: () => history([said('run-1', 'message', 'Send it')]) },
        runs,
        { ...actor, threadId: Option.none() },
      )
      expect(elsewhere).toEqual(Option.none())
    }),
  )
})
