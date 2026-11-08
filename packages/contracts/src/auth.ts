import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import type { Workspace } from './companies.js'
import type { Person, RunId, SessionId, ThreadId } from './identity.js'

/**
 * Who is making a product call.
 *
 * - `Person`: a signed-in human, working in one workspace.
 * - `Vivid`: Vivid, inside one Thread, acting for the Person who started the Run. It may do what
 *   that Person may do in that Thread and nothing more.
 * - `Helper`: a helper Run Vivid started in that Thread (`runs.ts`), acting for the same Person
 *   as the Run that started it. It may do what Vivid may do there, except what only the Run
 *   answering the Person does: ask them, notify them, post to their Feed, start another helper.
 *   Every action it proposes is attributed to `runId`, never to whichever Run is working.
 * - `Runtime`: the runtime process itself with no Thread, which may do nothing on anyone's behalf.
 */
export type AuthState = Data.TaggedEnum<{
  Person: {
    readonly person: Person
    readonly sessionId: SessionId
    readonly workspace: Workspace
  }
  Vivid: {
    readonly person: Person
    readonly workspace: Workspace
    readonly threadId: ThreadId
  }
  Helper: {
    readonly person: Person
    readonly workspace: Workspace
    readonly threadId: ThreadId
    readonly runId: RunId
  }
  Runtime: {}
}>

export const AuthState = Data.taggedEnum<AuthState>()

/** The request-local identity every handler reads. Provided by the transport's auth middleware. */
export class AuthContext extends Context.Service<AuthContext, AuthState>()('vivid/AuthContext') {}

/**
 * The headers the runtime sets on a product call so the server knows which Run is acting.
 * `helper` names the helper Run making the call; without it the call is Vivid's own.
 */
export const runtimeHeaders = {
  thread: 'x-vivid-thread',
  actor: 'x-vivid-actor',
  helper: 'x-vivid-helper',
} as const
