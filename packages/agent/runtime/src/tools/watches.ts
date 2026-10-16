import { defineTool } from '@flue/runtime'
import { Watch, WatchState } from '@vivid/contracts'
import { Effect } from 'effect'
import * as v from 'valibot'
import { summary, text } from './inputs.ts'
import { Scope, type RunTool } from './scope.ts'
import { modelText } from './views.ts'

/**
 * Watches: an Integration's event wakes Vivid (`apps/server/src/watches`). These tools are thin
 * calls to the server; it resolves the account to its Integration and Executor app, and keeps
 * every identifier. The model works only with account names, event names and Watch names.
 */

/** Model-visible in every Watch tool's description, without an agent edit. */
export const instructions =
  'When a Person wants to know or act when something happens in an Integration, find its events, then watch one with the instruction of what to do; say what you are watching. When woken by an event, act on the instruction; if nothing needs the Person, finish without a reply.'

/** A Watch as the model reads it: names and words, never its id or subscription. */
const view = (watch: Watch) => ({
  name: modelText(watch.name),
  watching: `${modelText(watch.event)} in ${modelText(watch.account)}`,
  filters: watch.arguments,
  instruction: modelText(watch.instruction),
  state: WatchState.match(watch.state, {
    Pending: () => 'starting',
    Active: () => 'watching',
    Stopped: () => 'stopped',
  }),
})

const account = text(
  'The exact Integration account name the Person was shown, such as Gmail (Work).',
  300,
)
const watchName = text(
  'A short name for the Watch the Person will recognise, such as "New mail in Work Gmail".',
  200,
)

export function watchTools(runTool: RunTool) {
  return [
    defineTool({
      name: 'find_events',
      description: `Find the events an Integration account can send, with the filters each one takes. ${instructions}`,
      input: v.object({ summary, account }),
      /** Declared events in words: the event's name, what it means and its filter names and types. */
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.FindAppEvents({ account: data.account })
            return {
              output: {
                events: response.events.map((event) => ({
                  event: modelText(event.event),
                  description: modelText(event.description),
                  filters: event.filters,
                })),
              },
            }
          }),
          { signal, tool: 'find_events' },
        )
      },
    }),
    defineTool({
      name: 'watch',
      description: `Watch an Integration event and act on it each time it happens. ${instructions}`,
      input: v.object({
        summary,
        name: watchName,
        account,
        event: text('The event name exactly as find_events returned it.', 200),
        filters: v.pipe(
          v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
          v.description('Values for the event’s filters, by filter name; {} to watch every event.'),
        ),
        instruction: text('What to do each time the event happens, in the Person’s words.', 4000),
      }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.CreateWatch({
              name: data.name.trim(),
              account: data.account,
              event: data.event,
              arguments: data.filters,
              instruction: data.instruction.trim(),
            })
            return { output: view(response.watch) }
          }),
          { signal, tool: 'watch' },
        )
      },
    }),
    defineTool({
      name: 'list_watches',
      description: 'List what Vivid is watching for the Person, by name.',
      input: v.object({ summary }),
      run({ signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.ListWatches()
            return { output: { watches: response.watches.map(view) } }
          }),
          { signal, tool: 'list_watches' },
        )
      },
    }),
    defineTool({
      name: 'stop_watching',
      description: 'Stop a Watch by its name.',
      input: v.object({ summary, name: watchName }),
      run({ data, signal }) {
        return runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const response = yield* client.StopWatch({ name: data.name.trim() })
            return { output: view(response.watch) }
          }),
          { signal, tool: 'stop_watching' },
        )
      },
    }),
  ] as const
}
