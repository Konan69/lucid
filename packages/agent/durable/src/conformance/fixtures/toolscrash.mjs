import * as NodeEvents from 'node:events'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { tool } from 'ai'
import { z } from 'zod'
import { streamRun, toolsExtension } from '../../main.ts'

/** Report the scope only after Pi's execution intent is durable; SIGKILL then tests actual recovery. */
const [, , file] = process.argv
if (file === undefined) throw new Error('Expected disposable database file')
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('scope', {}, { id: 'replayed' })], { stopReason: 'toolUse' }),
])
const registry = createRegistry()
registry.install(
  await toolsExtension(
    'conformance',
    {
      scope: tool({
        inputSchema: z.object({}),
        execute: (_input, options) => {
          process.stdout.write(`${JSON.stringify(options.context)}\n`)
          return NodeEvents.EventEmitter.once(process, 'SIGTERM')
        },
      }),
    },
    { replay: { scope: 'safe' } },
  ),
)
const harness = await Harness.open(
  await openNodeSqliteStorage(file),
  { models, registry },
  BACKGROUND_CONTEXT,
)
const root = await harness.root(BACKGROUND_CONTEXT, {
  agent: { model: { provider: 'faux', modelId: 'faux-1' } },
})
await streamRun(
  harness,
  { conversationId: root.id, content: 'Scope', requestId: 'crash' },
  BACKGROUND_CONTEXT,
)
