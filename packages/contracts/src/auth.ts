import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import type { Workspace } from './companies.js'
import type { Person, SessionId, ThreadId } from './identity.js'

/**
 * Who is making a product call.
 *
 * - `Person`: a signed-in human, working in one workspace.
 * - `Vivid`: Vivid, inside one Thread, acting for the Person who started the Run. It may do what
 *   that Person may do in that Thread and nothing more.
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
  Runtime: {}
}>

export const AuthState = Data.taggedEnum<AuthState>()

/** The request-local identity every handler reads. Provided by the transport's auth middleware. */
export class AuthContext extends Context.Service<AuthContext, AuthState>()('vivid/AuthContext') {}

/** The headers the runtime sets on a product call so the server knows which Run is acting. */
export const runtimeHeaders = {
  thread: 'x-vivid-thread',
  actor: 'x-vivid-actor',
} as const
