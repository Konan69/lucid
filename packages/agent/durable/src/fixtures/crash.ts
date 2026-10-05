import { Effect } from 'effect'
import { runForPi } from '../pi.ts'
// Child process of recovery.test.ts. It starts a run whose tool never returns, reports that the tool
// is running, and is then killed by the test. Nothing here closes the harness: the point is an
// unclean death with a tool call in flight.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Type } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

const context = BACKGROUND_CONTEXT
const [, , file] = process.argv
if (file === undefined) throw new Error('usage: crash.ts <sqlite file>')

const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('report', {}, { id: 'call-1' })], { stopReason: 'toolUse' }),
])

const registry = createRegistry()
registry.install(
  defineExtension({
    name: 'report',
    tools: [
      defineTool({
        name: 'report',
        description: 'Build the report',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: (_args, _api, callbackContext) =>
          runForPi(
            Effect.sync(() => {
              process.stdout.write('tool-running\n')
            }).pipe(Effect.andThen(Effect.never)),
            callbackContext.abortSignal,
          ),
      }),
    ],
  }),
)

const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context)
const root = await harness.root(context, {
  agent: { model: { provider: 'faux', modelId: 'faux-1' } },
})
await root.submit({ type: 'input', content: 'Build the report', requestId: 'r1' }, context)
