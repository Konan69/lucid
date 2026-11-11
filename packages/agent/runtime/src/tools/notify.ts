import { defineTool } from './tool.ts'
import { Tool, NotifyPersonOutcome, PushOutcome } from '@vivid/contracts'
import { Effect } from 'effect'
import * as v from 'valibot'
import { Scope, type RunTool } from './scope.ts'
import { summary, text } from './inputs.ts'

/**
 * The model sees delivery evidence, not target credentials, notification ids or recipient identity.
 * Each message says how far it got in words a reply can repeat ("it's in your notifications"),
 * because "push", "target" and "push service" are how it is delivered, not what the Person sees.
 */
const resultOf = (outcome: NotifyPersonOutcome) =>
  NotifyPersonOutcome.match(outcome, {
    Created: ({ push }) =>
      PushOutcome.match(push, {
        Present: () => ({
          output: {
            ok: true,
            status: 'present',
            acceptedTargets: 0,
            message:
              'It is in their notifications. They are in the app right now, so their phone was not buzzed.',
          },
        }),
        NoTargets: () => ({
          output: {
            ok: true,
            status: 'no-targets',
            acceptedTargets: 0,
            message:
              'It is in their notifications in the app, but none of their devices could be buzzed.',
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
              'It is in their notifications and their phone was sent an alert; that does not mean they have seen it. Do not send an alert that may already have gone again.',
          },
        }),
      }),
  })

/** A notification is a product-owned delivery to the acting Person, not an external account action. */
export function notifyTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.notify_person,
      description:
        'Tell the Person something worth their attention when they are away: a reminder that came due, an answer they are waiting for, something urgent you noticed; one or two short lines; not for chatter.',
      input: v.object({
        summary,
        title: text('A short title.', 100),
        body: text('One or two short lines explaining what needs attention.', 280),
        previewUrl: v.optional(
          text('An HTTPS image URL to show as a chart or document preview.', 2048),
        ),
      }),
      /** Runtime authority supplies the recipient and Thread; replay deduplication stays on the server. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const request =
              data.previewUrl === undefined
                ? { title: data.title, body: data.body }
                : { title: data.title, body: data.body, previewUrl: data.previewUrl }
            return resultOf(yield* client.NotifyPerson(request))
          }),
          { signal, tool: 'notify_person' },
        )
      },
    }),
  ] as const
}
