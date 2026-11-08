import { Effect } from 'effect'
import * as v from 'valibot'
import { ShellHandle, Tool } from '@vivid/contracts'
import { Scope, type RunTool } from './scope.ts'
import { defineTool } from './tool.ts'
import { COMPUTER_HOME } from './sandbox.ts'

const handle = v.pipe(
  v.string(),
  v.regex(/^[a-f0-9-]{36}$/u),
  v.description('The handle returned by start_shell.'),
)

/** Durable Computer work is server-owned. These tools only supply arguments under the current
 * acting Person; cancelling a read or wait never stops the command behind its handle. */
export function shellTools(runTool: RunTool) {
  return [
    defineTool({
      name: Tool.start_shell,
      description:
        'Start a long command in the background on your Computer. Returns a durable handle and output directory. Its completion wakes this Thread automatically; carry on with independent work.',
      input: v.object({ command: v.string(), directory: v.optional(v.string()) }),
      run: ({ data, signal }) =>
        runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            const output = yield* client.StartShell({
              command: data.command,
              directory: data.directory === undefined ? COMPUTER_HOME : data.directory,
            })
            return { output }
          }),
          { signal, tool: Tool.start_shell },
        ),
    }),
    defineTool({
      name: Tool.read_shell,
      description:
        'Read a background command’s current output and status without waiting. Whole output remains in its output directory when the returned tail is truncated.',
      input: v.object({ handle }),
      run: ({ data, signal }) =>
        runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            return { output: yield* client.ReadShell({ handle: ShellHandle.make(data.handle) }) }
          }),
          { signal, tool: Tool.read_shell },
        ),
    }),
    defineTool({
      name: Tool.wait_shell,
      description:
        'Wait for a background command when its result blocks your next step. Returns on completion or after the requested seconds. Other Computer work can continue during the wait.',
      input: v.object({
        handle,
        seconds: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(600)),
      }),
      run: ({ data, signal }) =>
        runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            return {
              output: yield* client.WaitShell({
                handle: ShellHandle.make(data.handle),
                seconds: data.seconds,
              }),
            }
          }),
          { signal, tool: Tool.wait_shell },
        ),
    }),
    defineTool({
      name: Tool.stop_shell,
      description:
        'Stop the command identified by this handle and read its final output. Stops only the process group that this handle started.',
      input: v.object({ handle }),
      run: ({ data, signal }) =>
        runTool(
          Effect.gen(function* () {
            const { client } = yield* Scope
            return { output: yield* client.StopShell({ handle: ShellHandle.make(data.handle) }) }
          }),
          { signal, tool: Tool.stop_shell },
        ),
    }),
  ]
}
