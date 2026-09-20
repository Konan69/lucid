import * as Effect from 'effect/Effect'
import { ConnectionDeletionResponse, ConnectionListResponse } from '@vivid/contracts'
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
}
