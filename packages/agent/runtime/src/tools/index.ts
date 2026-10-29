import * as NodeAsyncHooks from 'node:async_hooks'
import { Effect, type Layer } from 'effect'
import type { Memory, MemoryWriter } from '../memory.ts'
import type { ToolFailure } from './result.ts'
import { defineTool as durableTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { NobodyToActFor } from '../client.ts'
import { ToolScopeMissing } from './failure.ts'
import { askTools } from './ask.ts'
import { codeTools } from './code.ts'
import { computerTools } from './computer.ts'
import { connectionTools } from './connections.ts'
import { documentTools } from './documents.ts'
import { libraryTools } from './library.ts'
import { memoryTools } from './memory.ts'
import { notifyTools } from './notify.ts'
import { feedTools } from './feed.ts'
import { followTools } from './follow.ts'
import { projectNamed, projectTools } from './projects.ts'
import { forgetTools } from './forget.ts'
import type { ProjectOf } from './memory.ts'
import { owedTools } from './owed.ts'
import { todoTools } from './todos.ts'
import { watchTools } from './watches.ts'
import {
  scopeLayer,
  scopedRunner,
  toolRunner,
  memoryRunner,
  Scope,
  type ResolveScope,
} from './scope.ts'
import { skillTools } from './skills.ts'

/** Preserve main's registration order. Resolve authority separately for every invocation, inside
 * execute, so queued submissions cannot retain another Person's RPC client or Library folder.
 * The core supplies its configured entry directory; constructing tools does no I/O. */
export function tools(
  resolve: ResolveScope,
  resolvePerson: (call: Parameters<ResolveScope>[0]) => Effect.Effect<MemoryWriter, ToolFailure>,
  memory: Memory['Service'],
): ToolRegistration[] {
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
  /** A Project-scoped memory names its Project; the name resolves through the call's own scope. */
  const project: ProjectOf = (name) =>
    // @effect-diagnostics-next-line strictEffectProvide:off -- The per-call authority Layer, as in toolRunner.
    projectNamed(name).pipe(Effect.provide(current()))
  return catalogue(runTool, run, runMemory, project).map((definition) =>
    durableTool({
      ...definition,
      execute(args, api, context) {
        return local.run(api, () =>
          authority.run(scopeLayer(resolve, api), () => definition.execute(args, api, context)),
        )
      },
    }),
  )
}

/** A single catalogue owns registration order for discovery and invocation. */
function catalogue(
  runTool: ReturnType<typeof toolRunner>,
  run: ReturnType<typeof scopedRunner>,
  runMemory: ReturnType<typeof memoryRunner>,
  project: ProjectOf,
): ToolRegistration[] {
  return [
    ...computerTools(runTool, run),
    ...libraryTools(runTool),
    ...connectionTools(runTool),
    ...askTools(runTool),
    ...followTools(),
    ...memoryTools(runMemory, project),
    ...forgetTools(runTool),
    ...notifyTools(runTool),
    ...skillTools(runTool),
    ...watchTools(runTool),
    ...feedTools(runTool),
    ...projectTools(runTool),
    ...owedTools(runTool),
    ...todoTools(runTool),
    ...codeTools(runTool),
    ...documentTools(runTool),
  ]
}
