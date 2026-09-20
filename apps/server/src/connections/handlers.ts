import * as Effect from 'effect/Effect'
import { ConnectionDeletionResponse, ConnectionListResponse, Forbidden } from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/api'
import { invalidRequest } from '../rpc/failures.ts'
import { ConnectionStore } from './store.ts'

export const connectionHandlers = {
  ListConnections: Effect.fn('Rpc.ListConnections')(function* () {
    const store = yield* ConnectionStore
    return ConnectionListResponse.make({
      connectors: yield* store.list().pipe(Effect.mapError(invalidRequest)),
    })
  }),
  DeleteConnection: Effect.fn('Rpc.DeleteConnection')(function* ({ id }) {
    const store = yield* ConnectionStore
    const deleted = yield* store.remove(id).pipe(Effect.mapError(invalidRequest))
    return ConnectionDeletionResponse.make({ success: true, deleted })
  }),
  ExecuteConnectionTool: Effect.fn('Rpc.ExecuteConnectionTool')(function* ({
    connector,
    tool,
    input,
  }) {
    // Only Vivid's runtime acts through a Connection. A Person's session manages Connections but
    // never drives a provider action directly, so a browser cannot send mail by calling this RPC.
    const auth = yield* AuthContext
    if (!AuthState.$is('Runtime')(auth)) {
      return yield* new Forbidden({ message: 'Connection actions run only for Vivid' })
    }
    const store = yield* ConnectionStore
    return {
      output: yield* store.execute(connector, tool, input).pipe(Effect.mapError(invalidRequest)),
    }
  }),
}
