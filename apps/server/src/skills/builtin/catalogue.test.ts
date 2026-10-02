import { describe, expect, it } from '@effect/vitest'
import {
  Connection,
  ConnectionId,
  ConnectionOwnership,
  ConnectionState,
  ServiceId,
  SkillOrigin,
  SkillScope,
} from '@vivid/contracts'
import { taskTools } from '../../../../../packages/agent/runtime/src/tools/tasks.ts'
import { libraryTools } from '../../../../../packages/agent/runtime/src/tools/library.ts'
import { connectionTools } from '../../../../../packages/agent/runtime/src/tools/connections.ts'
import { askTools } from '../../../../../packages/agent/runtime/src/tools/ask.ts'
import { memoryTools } from '../../../../../packages/agent/runtime/src/tools/memory.ts'
import { skillTools } from '../../../../../packages/agent/runtime/src/tools/skills.ts'
import { routineTools } from '../../../../../packages/agent/runtime/src/tools/routines.ts'
import {
  computerDefinitions,
  desktopModelTool,
} from '../../../../../packages/agent/runtime/src/tools/computer.ts'
import { codeTools } from '../../../../../packages/agent/runtime/src/tools/code.ts'
import type { RunTool } from '../../../../../packages/agent/runtime/src/tools/scope.ts'
import * as views from '../../../../../packages/agent/runtime/src/tools/views.ts'
import { procedureSuggestions } from '../../search/suggestions.ts'
import { builtins, procedures, summary } from './index.ts'

/** Registration factories are the same ones used by Vivid, without running a tool or model. */
const runner: RunTool = () => Promise.resolve({ output: {}, terminate: false })
const registered = new Set(
  [
    ...taskTools(runner),
    ...libraryTools(runner),
    ...connectionTools(runner),
    ...askTools(runner),
    ...memoryTools(runner),
    ...skillTools(runner),
    ...routineTools(runner),
    ...computerDefinitions(runner),
    desktopModelTool(runner),
    ...codeTools(runner),
  ].map((tool) => tool.name),
)

/** Ready and pending accounts demonstrate that a service name alone cannot make an offer runnable. */
const connection = (serviceName: string, state: ConnectionState) =>
  Connection.make({
    id: ConnectionId.make('MARK-connection'),
    service: ServiceId.make('MARK-service'),
    serviceName,
    label: 'Work',
    ownership: ConnectionOwnership.cases.Shared.make({}),
    state,
    createdAt: 0,
  })

describe('shipped procedure catalogue', () => {
  it('uses registered tools, bounds instructions and projects no record handles', () => {
    expect(procedures).toHaveLength(12)
    for (const procedure of procedures) {
      expect(procedure.instructions.split(/\s+/).length).toBeGreaterThanOrEqual(150)
      expect(procedure.instructions.split(/\s+/).length).toBeLessThanOrEqual(350)
      for (const tool of procedure.needs)
        expect(registered.has(tool), `${procedure.name}: ${tool}`).toBe(true)
      for (const mention of procedure.instructions.matchAll(/`([a-z_]+)`/g)) {
        const tool = mention[1]
        if (tool === undefined) expect.fail('Tool reference is required')
        expect(registered.has(tool), `${procedure.name}: ${mention[1]}`).toBe(true)
        expect(procedure.needs).toContain(mention[1])
      }
      expect(procedure.instructions).not.toMatch(/\bagent\b/i)
    }
    for (const builtin of builtins) {
      expect(SkillOrigin.guards.BuiltIn(builtin.origin)).toBe(true)
      expect(SkillScope.guards.BuiltIn(builtin.scope)).toBe(true)
      const marked = { ...builtin, id: builtin.id, createdAt: 123, updatedAt: 456 }
      const model = JSON.stringify([
        views.skill(marked, builtin.name),
        views.skillSummary({ ...marked, useWhen: summary(builtin) }, builtin.name),
      ])
      expect(model).not.toContain(builtin.id)
      expect(model).not.toContain('createdAt')
      expect(model).not.toContain('"origin":')
      expect(model).toContain('takes precedence')
    }
  })

  it('offers connected work only with all dependencies ready, otherwise the four starters', () => {
    const fallback = procedureSuggestions([])
    expect(fallback).toHaveLength(4)
    expect(
      procedureSuggestions([
        connection('Gmail', ConnectionState.cases.NeedsAuthorization.make({})),
      ]),
    ).toEqual(fallback)
    const mail = procedureSuggestions([
      connection('Gmail', ConnectionState.cases.Ready.make({})),
    ]).map((item) => item.text)
    expect(mail).toContain('Triage my inbox')
    expect(mail).toContain('Draft a reply')
    expect(mail).not.toContain('Morning brief')
    const both = procedureSuggestions([
      connection('Gmail', ConnectionState.cases.Ready.make({})),
      connection('Google Calendar', ConnectionState.cases.Ready.make({})),
    ]).map((item) => item.text)
    expect(both).toContain('Morning brief')
  })
})
