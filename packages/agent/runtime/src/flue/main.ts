import { NodeHttpClient, NodeRuntime } from '@effect/platform-node'
import type { PersonId } from '@vivid/contracts'
import { ConfigProvider, Console, Effect, Layer, Schema, Scope } from 'effect'
import { productLayer } from '../client.ts'
import { modelsLayer } from '../models.ts'
import { runtimeNotesLayer } from '../persons.ts'
import { openPerson, type PersonConversations } from '../person.ts'
import { settingsLayer } from '../settings.ts'
import { builtinSkillsLayer } from '../skills.ts'
import { Stores, storesLayer } from '../storage/stores.ts'
import { carry } from './carry.ts'
import type { Carried } from './fold.ts'
import { flueSourceLayer } from './source.ts'
import { sweep, type Report } from './sweep.ts'

/** Some Threads were not carried; each one's line says why. The process exits non-zero. */
class ThreadsFailed extends Schema.TaggedError<ThreadsFailed>()(
  'ThreadsFailed',
  { failed: Schema.Int },
  { title: 'Some Flue Threads were not carried' },
) {
  override get message() {
    return `${this.failed} Thread(s) were not carried`
  }
}

/** One line per Thread on standard output, as JSON. Ids, counts and reasons only. */
const print = (line: Report) => Console.log(JSON.stringify(line))

/**
 * Carry every old Flue Thread into the Pi runtime's stores: `pnpm import:flue`.
 *
 * The importer is a runtime process for the length of the run. Building `storesLayer` takes the
 * same runtime-wide authority the server process takes (the advisory lock and the next owner
 * generation, `storage/stores.ts`), so it refuses with `RuntimeOwned` while a runtime is running
 * and a runtime cannot start while it runs; losing the control connection ends it as it ends the
 * runtime. A Person's conversations are opened by the runtime's own `openPerson` with the same
 * settings, models, skills and product client, and closed when the run ends. Unlike a serving
 * runtime it never calls `resume()`, so no unfinished reply in a store starts running here.
 *
 * It needs the runtime's settings (`settings.ts`) and `VIVID_FLUE_DATABASE_URL`, the database to
 * read Flue's conversations from, which is only ever read.
 */
const run = Effect.fn('Flue.import')(function* () {
  const stores = yield* Stores
  const scope = yield* Effect.scope
  const opened = new Map<PersonId, PersonConversations>()
  const open = (personId: PersonId) => {
    const known = opened.get(personId)
    if (known !== undefined) return Effect.succeed(known)
    return openPerson(personId).pipe(
      Scope.provide(scope),
      Effect.tap((person) => Effect.sync(() => opened.set(personId, person))),
    )
  }
  const carryInto = (personId: PersonId, carried: Carried) =>
    Effect.flatMap(open(personId), (person) => carry(person.harness, carried))
  const summary = yield* Effect.raceFirst(stores.lost, sweep(carryInto, print))
  yield* Console.log(JSON.stringify({ summary }))
  if (summary.failed > 0) return yield* new ThreadsFailed({ failed: summary.failed })
  return summary
})

const entry = Layer.mergeAll(
  storesLayer,
  productLayer.pipe(Layer.provide(NodeHttpClient.layerUndici)),
  modelsLayer,
  builtinSkillsLayer,
  runtimeNotesLayer,
  flueSourceLayer,
).pipe(
  Layer.provideMerge(settingsLayer),
  // oxlint-disable-next-line vivid/no-config-provider-from-env-in-library -- This is the importer's process entry point, the one place the environment becomes configuration.
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
)

NodeRuntime.runMain(
  // @effect-diagnostics-next-line strictEffectProvide:off -- The process entry point provides its composed Layer once.
  Effect.scoped(run()).pipe(Effect.provide(entry)),
)
