// Disposable child of conformance/sequential.test.ts: die only after the second task is waiting.
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
import { Option } from 'effect'
import { continueRun, decide, streamRun, toolsExtension, waiting } from '../main.ts'

const context = BACKGROUND_CONTEXT
const [, , file] = process.argv
if (file === undefined) throw new Error('Expected disposable SQLite path')
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall('pay', { amount: 1 }, { id: 'c1' }),
      fauxToolCall('pay', { amount: 2 }, { id: 'c2' }),
    ],
    { stopReason: 'toolUse' },
  ),
])
const registry = createRegistry()
registry.install(
  await toolsExtension(
    'conformance',
    {
      pay: tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => amount,
      }),
    },
    { approval: { pay: true } },
  ),
)
const harness = await Harness.open(
  await openNodeSqliteStorage(file),
  { models, registry, settings: { toolExecution: 'sequential' } },
  context,
)
const root = await harness.root(context, {
  agent: { model: { provider: 'faux', modelId: 'faux-1' } },
})
let messageId = Option.none<string>()
for await (const chunk of await streamRun(
  harness,
  { conversationId: root.id, content: 'Pay both', requestId: 'crash-sequential' },
  context,
)) {
  if (chunk.type === 'start') messageId = Option.fromNullishOr(chunk.messageId)
}
const first = (await waiting(harness, root.id, context)).find((row) => row.callId === 'c1')
if (first === undefined) throw new Error('Expected c1 hold')
await decide(harness, root.id, { holdId: first.holdId, approved: true }, context)
for await (const _chunk of await continueRun(
  harness,
  root.id,
  { messageId: Option.getOrThrow(messageId), known: new Set(['c1']) },
  context,
)) {
  /* Drain to the second park. */
}
if (!(await waiting(harness, root.id, context)).some((row) => row.callId === 'c2'))
  throw new Error('Expected c2 hold')
process.stdout.write('c2-waiting\n')
