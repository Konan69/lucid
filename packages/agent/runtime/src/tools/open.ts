import { defineTool } from '@flue/runtime'
import { Effect } from 'effect'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import { text } from './inputs.ts'
import { modelText } from './views.ts'

/** Private finding Threads use product admission; the model never selects an owner or Company. */
export function openTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'open_thread',
      description:
        'During Watch what needs me, open a private Thread for one verified issue that needs the Person. Include evidence, source references and the next step. Vivid continues there and calls notify_person there; do not also notify from this working Thread. Only the standing check can use this tool.',
      input: v.object({
        title: text('A short title for this one issue.', 100),
        context: text('Verified evidence, references and the next step.', 4000),
      }),
      /** Only confirmed product words return; ownership and conversation identifiers remain hidden. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const opened = yield* client.OpenThread(data)
            return {
              output: {
                ok: true,
                title: modelText(opened.title),
                message:
                  'Opened private work. Vivid will notify from that Thread; do not notify this issue again here.',
              },
            }
          }),
          { signal, tool: 'open_thread' },
        )
      },
    }),
  ] as const
}
