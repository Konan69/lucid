// Disposable child of conformance/delivery.test.ts. Die after answer admission, before its receipt
// is recorded: Pi session.js publishes commits synchronously before the committing Promise resolves.
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
import { answer, streamRun, toolsExtension, waiting } from '../main.ts'

const context = BACKGROUND_CONTEXT
const [, , file] = process.argv
if (file === undefined) throw new Error('Expected disposable SQLite path')
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('later', { question: 'Which?' }, { id: 'x' })], {
    stopReason: 'toolUse',
  }),
  fauxAssistantMessage([fauxToolCall('pay', { amount: 100 }, { id: 'pay' })], {
    stopReason: 'toolUse',
  }),
])
const registry = createRegistry()
registry.install(
  await toolsExtension(
    'conformance',
    {
      later: tool({ inputSchema: z.object({ question: z.string() }) }),
      pay: tool({
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => ({ receipt: amount }),
      }),
    },
    { approval: { pay: true }, answers: { later: 'later' } },
  ),
)
const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context)
const root = await harness.root(context, {
  agent: { model: { provider: 'faux', modelId: 'faux-1' } },
})
for await (const _chunk of await streamRun(
  harness,
  { conversationId: root.id, content: 'Ask then pay', requestId: 'crash-answer' },
  context,
)) {
  /* Drain to the payment hold. */
}
const question = (await waiting(harness, root.id, context)).find((row) => row.kind === 'later')
if (question === undefined) throw new Error('Expected late question')
harness.subscribeCommits((publication) => {
  if (
    publication.changes.some(
      (change) =>
        change.type === 'submission' && change.value.requestId === `answer:${question.holdId}:0`,
    )
  )
    process.kill(process.pid, 'SIGKILL')
})
await answer(harness, root.id, { holdId: question.holdId, output: 'savings' }, context)
throw new Error('Expected death before answer receipt commit')
