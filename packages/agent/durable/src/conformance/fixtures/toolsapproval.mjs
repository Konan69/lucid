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
import { tool, DefaultChatTransport } from 'ai'
import { z } from 'zod'
import { PlainChat } from '../../fixtures/chat.ts'
import { respond, toolsExtension } from '../../main.ts'

/** Signal only after stock Chat parks on the committed hook memo, then await an external kill. */
const [, , file] = process.argv
if (file === undefined) throw new Error('Expected disposable database')
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('pay', {}, { id: 'pay' })], { stopReason: 'toolUse' }),
])
const registry = createRegistry()
registry.install(
  await toolsExtension('conformance', {
    pay: tool({
      inputSchema: z.object({}),
      needsApproval: () => true,
      execute: async () => 'paid',
    }),
  }),
)
const harness = await Harness.open(
  await openNodeSqliteStorage(file),
  { models, registry },
  BACKGROUND_CONTEXT,
)
const root = await harness.root(BACKGROUND_CONTEXT, {
  agent: { model: { provider: 'faux', modelId: 'faux-1' } },
})
const chat = new PlainChat({
  transport: new DefaultChatTransport({
    api: 'http://durable.test/chat',
    fetch: async (url, init) =>
      respond(harness, root.id, new Request(url, init), BACKGROUND_CONTEXT),
  }),
})
await chat.sendMessage({ text: 'Pay' })
process.stdin.resume()
process.stdout.write('pinned\n')
await NodeEvents.EventEmitter.once(process, 'SIGTERM')
