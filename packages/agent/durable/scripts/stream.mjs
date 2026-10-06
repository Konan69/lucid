import * as NodeAssert from 'node:assert/strict'
import * as NodeURL from 'node:url'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { DefaultChatTransport, readUIMessageStream } from 'ai'
import * as Durable from '@vivid/durable'
import * as Core from '@vivid/durable/core'

const context = BACKGROUND_CONTEXT
const text = 'Tarball streamed successfully.'
const faux = fauxProvider()
faux.setResponses([fauxAssistantMessage(text)])
const models = createModels()
models.setProvider(faux.provider)
NodeAssert.equal(Durable.TurnInvalid, Core.TurnInvalid, 'Entries must share their contracts')

// Adapt fixtures/harness.ts's public model/registry setup to a disposable SQLite file.
// Register each resource's cleanup before the next acquisition or assertion can fail.
const storage = await openNodeSqliteStorage(
  NodeURL.fileURLToPath(new URL('turn.sqlite', import.meta.url)),
)
try {
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context)
  try {
    const conversation = await harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } },
    })
    // DefaultChatTransport's stock SSE decoder reads the real Response from Request ingress;
    // the fetch adapter routes in-process and never contacts a server or live provider.
    const transport = new DefaultChatTransport({
      api: 'https://durable.test/chat',
      fetch: (url, init) =>
        Durable.respond(harness, conversation.id, new Request(url, init), context),
    })
    const stream = await transport.sendMessages({
      chatId: 'package-proof',
      trigger: 'submit-message',
      messages: [{ id: 'turn-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    })
    let message
    for await (const next of readUIMessageStream({ stream, terminateOnError: true })) message = next
    NodeAssert.ok(message, 'Expected an assistant message from the SDK reader')
    NodeAssert.equal(message.role, 'assistant')
    NodeAssert.deepEqual(
      message.parts.filter((part) => part.type === 'text').map((part) => part.text),
      [text],
    )
    NodeAssert.equal(faux.state.callCount, 1)
    process.stdout.write(`Streamed text: ${text}\n`)
  } finally {
    await harness.close(context)
  }
} finally {
  await storage.close(context)
}
