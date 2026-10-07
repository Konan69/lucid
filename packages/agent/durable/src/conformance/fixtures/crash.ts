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

import { toolsExtension } from '../../tools.ts'
import { runForPi } from '../../pi.ts'

/**
 * Pi harness-tools-recovery.test.ts: interruption after intent, adapted to a real process death.
 * Like src/fixtures/crash.ts, report execution only after Pi has persisted the call's intent.
 * The bridge supplies replay policy; no test writes Pi task checkpoints or patches its scheduler.
 */
const [, , file, policy] = process.argv
if (file === undefined || (policy !== 'safe' && policy !== 'unsafe'))
  throw new Error('Expected database file and replay policy')
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('work', {}, { id: 'interrupted' })], {
    stopReason: 'toolUse',
  }),
])
const registry = createRegistry()
registry.install(
  await runForPi(
    toolsExtension(
      'conformance',
      {
        work: tool({
          description: 'Build a report',
          inputSchema: z.object({}),
          execute: () => {
            process.stdout.write('executing\n')
            // SIGKILL bypasses signal handlers; this real process wait stays in flight at the crash.
            return NodeEvents.EventEmitter.once(process, 'SIGTERM')
          },
        }),
      },
      { replay: { work: policy } },
    ),
    BACKGROUND_CONTEXT.abortSignal,
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
// The crashed host admits natively: loading respond/history/stream modules adds startup work but
// cannot change this replay-policy proof. The bridged registration and durable intent are retained.
await root.submit(
  { type: 'input', content: 'Build a report', requestId: 'crash' },
  BACKGROUND_CONTEXT,
)
