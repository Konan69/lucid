import { defineTool } from '@flue/runtime'
import { NotifyPersonOutcome, PushOutcome } from '@vivid/contracts'
import { Effect } from 'effect'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import { summary, text } from './inputs.ts'

/** The model sees delivery evidence, not target credentials, notification ids or recipient identity. */
const resultOf = (outcome: NotifyPersonOutcome) =>
  NotifyPersonOutcome.match(outcome, {
    Disabled: () => ({
      output: {
        ok: false,
        status: 'disabled',
        message: 'The Person has turned notifications off.',
      },
    }),
    Created: ({ push }) =>
      PushOutcome.match(push, {
        Present: () => ({
          output: {
            ok: true,
            status: 'present',
            acceptedTargets: 0,
            message: 'The notification is in the app. The Person is present, so no push was sent.',
          },
        }),
        Unavailable: () => ({
          output: {
            ok: true,
            status: 'unavailable',
            acceptedTargets: 0,
            message: 'The notification is in the app. Push is unavailable.',
          },
        }),
        NoTargets: () => ({
          output: {
            ok: true,
            status: 'no-targets',
            acceptedTargets: 0,
            message: 'The notification is in the app. No active push target could receive it.',
          },
        }),
        Attempted: ({ accepted, failed, uncertain }) => ({
          output: {
            ok: true,
            status: 'attempted',
            acceptedTargets: accepted,
            failedTargets: failed,
            uncertainTargets: uncertain,
            message:
              'Accepted means the push service received it, not that the Person saw it. Do not repeat an uncertain delivery.',
          },
        }),
      }),
  })

/** A notification is a product-owned delivery to the acting Person, not an external account action. */
export function notifyTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'notify_person',
      description:
        'Tell the Person something worth their attention when they are away: a reminder that came due, an answer they are waiting for, something urgent you noticed; one or two short lines; not for chatter.',
      input: v.object({
        summary,
        title: text('A short title.', 100),
        body: text('One or two short lines explaining what needs attention.', 280),
      }),
      /** Runtime authority supplies the recipient and Thread; replay deduplication stays on the server. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            return resultOf(yield* client.NotifyPerson({ title: data.title, body: data.body }))
          }),
          { signal, tool: 'notify_person' },
        )
      },
    }),
  ] as const
}
