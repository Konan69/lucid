import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import { Effect, Layer } from 'effect'
import { serverConfigLayer } from '../../config.ts'
import { databaseLayer } from '../../database/client.ts'
import { cutoverReceipts } from '../cutover.ts'

/** Use the server's configured database adapter without starting HTTP or background workers. */
NodeRuntime.runMain(
  cutoverReceipts().pipe(
    Effect.provide(databaseLayer.pipe(Layer.provide(serverConfigLayer))),
  ),
)
