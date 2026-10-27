import {
  openDurableObjectSqliteStorage,
  type DurableObjectSqliteStorage,
} from '@earendil-works/pi-durable/storage/sqlite/cloudflare'
import type { HarnessOptions } from '@earendil-works/pi-durable'
import type { PersonId } from '@vivid/contracts'
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpRouter from 'effect/http/HttpRouter'
import { routes } from './app.ts'
import { productLayer } from './client.ts'
import type { LoadedSkill } from './frontmatter.ts'
import { modelsLayer } from './models.ts'
import { Notes } from './notes.ts'
import { PiRejected } from './threads.ts'
import { openPerson, Person } from './person.ts'
import { settingsLayer } from './settings.ts'
import { BuiltinSkills, skillsExtension } from './skills.ts'

export { isAuthorized } from './app.ts'
export { parseSkill } from './frontmatter.ts'
export type { LoadedSkill } from './frontmatter.ts'

/** Native cell resources and authority are explicit. A caller cannot substitute a Person id
 * to choose storage; celld supplies the storage of the already addressed cell. */
export interface CellInput {
  readonly personId: PersonId
  readonly storage: DurableObjectSqliteStorage
  readonly onWake: NonNullable<HarnessOptions['onWake']>
  readonly notes: Notes['Service']
  readonly skills: ReadonlyArray<LoadedSkill>
  readonly environment: object
}

/**
 * Construct the runtime without a Node listener. The same bound Person serves every request;
 * celld owns activation and eviction, and Pi owns task recovery and queued inputs.
 */
export const openCell = (input: CellInput) => {
  const foundation = Layer.mergeAll(settingsLayer, modelsLayer).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input.environment))),
  )
  const dependencies = Layer.mergeAll(
    productLayer.pipe(Layer.provide(FetchHttpClient.layer)),
    Layer.succeed(Notes, input.notes),
    Layer.succeed(BuiltinSkills, skillsExtension(input.skills)),
  ).pipe(Layer.provideMerge(foundation))
  const person = Layer.effect(
    Person,
    Effect.gen(function* () {
      const storage = yield* Effect.tryPromise({
        try: () => openDurableObjectSqliteStorage(input.storage, { prefix: 'pi_' }),
        catch: (cause) => new PiRejected({ cause }),
      })
      return yield* openPerson(input.personId, storage, input.onWake)
    }),
  ).pipe(Layer.provideMerge(dependencies))
  const runtime = ManagedRuntime.make(person)
  // Route request requirements are separate from layer construction; expose their services to the handler.
  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provideMerge(person)), {
    memoMap: runtime.memoMap,
    disableLogger: true,
  })
  return runtime.context().then((context) => ({
    person: Context.get(context, Person),
    fetch: (request: Request) => web.handler(request),
  }))
}
