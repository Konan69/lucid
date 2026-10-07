// An owned child stops its first generation after a committed partial. The parent kills this
// captured process, then proves attribution from real recovery on the same SQLite/PG storage.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, LiveDoc } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Config, Effect, Schema } from 'effect'
import { runForPi } from '../../pi.ts'
import { Pool } from 'pg'
import { openPgStorage } from '../../postgres/main.ts'
import { streamingProvider, waitForFrame } from '../../fixtures/provider.ts'

/** Process ingress owns storage initialization and the deliberate crash; no cleanup runs after SIGKILL. */
async function main() {
  const context = BACKGROUND_CONTEXT
  const [, , backend, address] = process.argv
  if (address === undefined) throw new Error('Expected disposable storage address')
  const storage =
    backend === 'sqlite'
      ? await openNodeSqliteStorage(address)
      : await openPgStorage(
          new Pool({
            connectionString: await runForPi(
              Effect.gen(function* () {
                return yield* Config.schema(Schema.String, 'VIVID_TEST_DATABASE_URL')
              }),
              undefined,
            ),
          }),
          address,
        )
  const faux = streamingProvider({
    partialFamily: 'parsed',
    onFrame: (event, signal) =>
      event.type === 'text_delta' ? waitForFrame(Effect.never, signal) : Effect.void,
  })
  faux.setResponses([fauxAssistantMessage('Interrupted first generation.')])
  const models = createModels()
  models.setProvider(faux.provider)
  const harness = await Harness.open(
    storage,
    { models, registry: createRegistry(), settings: { progress: { partialIntervalMs: 0 } } },
    context,
  )
  const root = await harness.root(context, {
    agent: { model: { provider: 'faux', modelId: 'faux-1' } },
  })
  const watch = await harness.watchDoc(LiveDoc, root.id, context)
  if (watch === undefined) throw new Error('Expected live document')
  let announced = false
  watch.start(function reportGeneration(live) {
    if (
      !announced &&
      live !== null &&
      live.run !== undefined &&
      live.generation !== undefined &&
      live.generation.message !== undefined
    ) {
      announced = true
      if (process.send === undefined) throw new Error('Expected parent IPC channel')
      process.send(live.run.taskId)
    }
    return Promise.resolve()
  })
  await root.submit({ type: 'input', content: 'Start', requestId: 'crashed' }, context)
}
await main()
