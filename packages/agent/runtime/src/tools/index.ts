import * as NodeAsyncHooks from 'node:async_hooks'
import { Effect, type Layer } from 'effect'
import type { PersonId } from '@vivid/contracts'
import type { Notes } from '../notes.ts'
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
import { noteTools } from './notes.ts'
import { notifyTools } from './notify.ts'
import { feedTools } from './feed.ts'
import { followTools } from './follow.ts'
import { projectTools } from './projects.ts'
import { watchTools } from './watches.ts'
import {
  scopeLayer,
  scopedRunner,
  toolRunner,
  noteRunner,
  Scope,
  type ResolveScope,
} from './scope.ts'
import { skillTools } from './skills.ts'

/** Preserve main's registration order. Resolve authority separately for every invocation, inside
 * execute, so queued submissions cannot retain another Person's RPC client or Library folder.
 * The core supplies its configured note directory; constructing tools does no I/O. */
export function tools(
  resolve: ResolveScope,
  resolvePerson: (call: Parameters<ResolveScope>[0]) => Effect.Effect<PersonId, ToolFailure>,
  notes: Notes['Service'],
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
  const runNote = noteRunner(() => {
    const call = local.getStore()
    if (call === undefined)
      return Effect.fail(new NobodyToActFor({ message: 'Note execution has no delivery scope.' }))
    return resolvePerson(call)
  }, notes)
  return catalogue(runTool, run, runNote).map((definition) =>
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
  runNote: ReturnType<typeof noteRunner>,
): ToolRegistration[] {
  return [
    ...computerTools(runTool, run),
    ...libraryTools(runTool),
    ...connectionTools(runTool),
    ...askTools(runTool),
    ...noteTools(runNote),
    ...memoryTools(runTool),
    ...notifyTools(runTool),
    ...feedTools(runTool),
    ...followTools(),
    ...skillTools(runTool),
    ...watchTools(runTool),
    ...projectTools(runTool),
    ...codeTools(runTool),
    ...documentTools(runTool),
  ]
}
