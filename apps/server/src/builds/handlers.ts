import { Effect } from 'effect'
import { requirePerson } from '../auth/access.ts'
import { ServerConfig } from '../config.ts'
import { live } from '../live/query.ts'

/** The commit this server was built from, read once at launch (`config.ts` `BUILD`). */
const build = Effect.fn('Build.get')(function* () {
  return (yield* ServerConfig).BUILD
})

export const buildHandlers = {
  GetBuild: Effect.fn('Rpc.GetBuild')(function* () {
    yield* requirePerson()
    return yield* build()
  }),
  /**
   * Answers once and never changes: a server's build is fixed for its life. A deploy replaces
   * the server, the client's socket opens again on the new one, and the subscription answers
   * with the new build there.
   */
  WatchBuild: () => live('WatchBuild', [], build),
}
