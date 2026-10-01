import { defineTool } from '@flue/runtime'
import { BrowserAction, RunCommandRequest } from '@vivid/contracts'
import * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import type * as Schema from 'effect/Schema'
import * as v from 'valibot'
import { asActing, type Acting } from '../client.ts'
import { summary, text } from './inputs.ts'
import { browseOutcome, commandOutcome } from './outcomes.ts'
import { settle } from './result.ts'

const action = v.variant('kind', [
  v.object({ kind: v.literal('open'), address: text('The page address to open.', 4000) }),
  v.object({ kind: v.literal('read') }),
  v.object({ kind: v.literal('click'), target: text('The page target to click.', 4000) }),
  v.object({
    kind: v.literal('type'),
    target: text('The page target to fill.', 4000),
    text: text('The text to enter.', 4000),
  }),
  v.object({ kind: v.literal('press'), key: text('The key or key combination.', 200) }),
  v.object({ kind: v.literal('screenshot') }),
])

/** The model vocabulary maps exhaustively to the server's closed BrowserAction contract. */
function browserAction(input: v.InferOutput<typeof action>): BrowserAction {
  switch (input.kind) {
    case 'open':
      return BrowserAction.cases.Open.make({ address: input.address })
    case 'read':
      return BrowserAction.cases.Read.make({})
    case 'click':
      return BrowserAction.cases.Click.make({ target: input.target })
    case 'type':
      return BrowserAction.cases.Type.make({ target: input.target, text: input.text })
    case 'press':
      return BrowserAction.cases.Press.make({ key: input.key })
    case 'screenshot':
      return BrowserAction.cases.Screenshot.make({})
  }
  return input
}

/** Computer tools propose actions only; availability, takeover and approvals belong to the server. */
export function computerTools(acting: Option.Option<Acting>) {
  return [
    defineTool({
      name: 'run_command',
      description:
        'Run a command on the person’s Computer when needed for their request. If approval is requested, stop and wait.',
      input: v.object({
        command: text('The command to run.', 8000),
        summary,
        timeoutSeconds: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.description('Maximum seconds to wait for the command.'),
          ),
        ),
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        const request: Schema.Struct.Mutable<RunCommandRequest> = {
          command: data.command,
          summary: data.summary,
        }
        if (data.timeoutSeconds !== undefined) request.timeoutSeconds = data.timeoutSeconds
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client.RunCommand(RunCommandRequest.make(request)).pipe(Effect.map(commandOutcome)),
            ),
          ),
          { signal },
        )
      },
    }),
    defineTool({
      name: 'browse',
      description:
        'Open, read or interact with a page on the person’s Computer. If approval is requested, stop and wait.',
      input: v.object({
        action: v.pipe(action, v.description('The browser action and the fields it needs.')),
        summary,
      }),
      /** Flue owns input decoding and cancellation; this boundary executes the attributed RPC Effect. */
      run({ data, signal }) {
        return Effect.runPromise(
          settle(
            asActing(acting, (client) =>
              client
                .Browse({ action: browserAction(data.action), summary: data.summary })
                .pipe(Effect.map(browseOutcome)),
            ),
          ),
          { signal },
        )
      },
    }),
  ] as const
}
