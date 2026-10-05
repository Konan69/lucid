import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Schema from 'effect/Schema'
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

/**
 * The apps that sign in with a code (the device authorization grant), by the name each gives the
 * server as its `client_id`. This is the whole list: the server issues a code to no other name,
 * and the page where a Person approves a code says which of these asked.
 *
 * A name is a label, not proof. Anything that can reach the server can send one of these, so it
 * decides only the words a Person reads, never whether a request is trusted.
 */
export const PairingClient = Schema.Literals(['vivid-mobile'])
export type PairingClient = typeof PairingClient.Type
