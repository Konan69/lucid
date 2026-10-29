import * as NodeAsyncHooks from 'node:async_hooks'
import { Effect, type Layer } from 'effect'
import type { MemoryAuthority } from '@vivid/contracts'
import type { Memory } from '../memory.ts'
import type { ToolFailure } from './result.ts'
import { defineTool as durableTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { NobodyToActFor } from '../client.ts'
import { ToolScopeMissing } from './failure.ts'
import { capabilityRegistry } from './capabilities.ts'
import {
  scopeLayer,
  scopedRunner,
  toolRunner,
  memoryRunner,
  Scope,
  type ResolveScope,
} from './scope.ts'

/** Preserve main's registration order. Resolve authority separately for every invocation, inside
 * execute, so queued submissions cannot retain another Person's RPC client or Library folder.
 * The core supplies its configured entry directory; constructing tools does no I/O. */
export function tools(
  resolve: ResolveScope,
  resolvePerson: (call: Parameters<ResolveScope>[0]) => Effect.Effect<MemoryAuthority, ToolFailure>,
  memory: Memory['Service'],
  skills: ReadonlyArray<ToolRegistration>,
) {
  const authority = new NodeAsyncHooks.AsyncLocalStorage<Layer.Layer<Scope, ToolFailure>>()
  /** Node's invocation-local storage keeps concurrent calls isolated while sharing warm tools. */
  const current = () => {
    const layer = authority.getStore()
    if (layer === undefined)
      throw new ToolScopeMissing({ message: 'Tool execution has no authority scope.' })
    return layer
  }
  const runTool: ReturnType<typeof toolRunner> = (program, options) =>
    toolRunner(current())(program, options)
  const run: ReturnType<typeof scopedRunner> = (program, signal) =>
    scopedRunner(current())(program, signal)
  const local = new NodeAsyncHooks.AsyncLocalStorage<Parameters<ResolveScope>[0]>()
  const runMemory = memoryRunner(() => {
    const call = local.getStore()
    if (call === undefined)
      return Effect.fail(
        new NobodyToActFor({ message: 'Memory tool execution has no delivery scope.' }),
      )
    return resolvePerson(call)
  }, memory)
  const registry = capabilityRegistry({ runTool, run, runMemory, memory, skills })
  const mounted = registry.tools.map((definition) =>
    durableTool({
      ...definition,
      execute(args, api, context) {
        return local.run(api, () =>
          authority.run(scopeLayer(resolve, api), () => definition.execute(args, api, context)),
        )
      },
    }),
  )
  return { tools: mounted, reading: registry.reading }
}
