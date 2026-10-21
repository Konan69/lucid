import type { ReadPageRequest, RunCodeRequest, RunDisplayCodeRequest } from '@vivid/contracts'
import { Effect } from 'effect'
import { requirePerson, requireVivid } from '../auth/access.ts'
import { CodeCalls } from './calls.ts'
import { readPage } from './pages.ts'
import { CodeProcess } from './process.ts'
import { displayThread } from './source.ts'

/** Every entry point injects Person authority; display Thread references are checked before use. */
export const codeHandlers = {
  RunCode: Effect.fn('Rpc.RunCode')(function* (request: RunCodeRequest) {
    const auth = yield* requireVivid()
    const calls = yield* CodeCalls
    const process = yield* CodeProcess
    const boundary = { person: auth.person.id, thread: auth.threadId }
    return yield* process.run({ request, boundary }, calls.bind(boundary))
  }),
  /** Access is checked before opening a Computer; queued calls refresh that same boundary. */
  RunDisplayCode: Effect.fn('Rpc.RunDisplayCode')(function* (request: RunDisplayCodeRequest) {
    const auth = yield* requirePerson()
    const thread = yield* displayThread(request.source, auth.person.id, request.code)
    const calls = yield* CodeCalls
    const process = yield* CodeProcess
    const boundary = { person: auth.person.id, thread }
    const dispatch = request.kind === 'Query' ? calls.bindQuery(boundary) : calls.bind(boundary)
    return yield* process.runDisplay(
      { request: { code: request.code, summary: request.summary }, boundary, kind: request.kind },
      dispatch,
    )
  }),
  ReadPage: Effect.fn('Rpc.ReadPage')(function* (request: ReadPageRequest) {
    yield* requireVivid()
    return yield* readPage(request)
  }),
}
