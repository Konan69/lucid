import type { ReadPageRequest, RunCodeRequest } from '@vivid/contracts'
import { Effect } from 'effect'
import { requireVivid } from '../auth/access.ts'
import { CodeCalls } from './calls.ts'
import { readPage } from './pages.ts'
import { CodeProcess } from './process.ts'

/** Both entry points inject identity. Programs cannot target a Person, Company, Computer or Thread. */
export const codeHandlers = {
  RunCode: Effect.fn('Rpc.RunCode')(function* (request: RunCodeRequest) {
    const auth = yield* requireVivid()
    const calls = yield* CodeCalls
    const process = yield* CodeProcess
    const boundary = { person: auth.person.id, thread: auth.threadId }
    return yield* process.run({ request, boundary }, calls.bind(boundary))
  }),
  ReadPage: Effect.fn('Rpc.ReadPage')(function* (request: ReadPageRequest) {
    yield* requireVivid()
    return yield* readPage(request)
  }),
}
