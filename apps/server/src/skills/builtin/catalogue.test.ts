import { describe, expect, it } from '@effect/vitest'
import {
  Connection,
  ConnectionId,
  ConnectionOwnership,
  ConnectionState,
  ServiceId,
  PersonId,
  PersonSummary,
  Skill,
  SkillId,
  SkillOrigin,
  SkillScope,
} from '@vivid/contracts'
import { libraryTools } from '../../../../../packages/agent/runtime/src/tools/library.ts'
import { connectionTools } from '../../../../../packages/agent/runtime/src/tools/connections.ts'
import { askTools } from '../../../../../packages/agent/runtime/src/tools/ask.ts'
import { memoryTools } from '../../../../../packages/agent/runtime/src/tools/memory.ts'
import { noteTools } from '../../../../../packages/agent/runtime/src/tools/notes.ts'
import { skillTools } from '../../../../../packages/agent/runtime/src/tools/skills.ts'
import { routineTools } from '../../../../../packages/agent/runtime/src/tools/routines.ts'
import {
  commandDefinition,
  pictureTools,
} from '../../../../../packages/agent/runtime/src/tools/computer.ts'
import { documentTools } from '../../../../../packages/agent/runtime/src/tools/documents.ts'
import { showTools } from '../../../../../packages/agent/runtime/src/tools/show.ts'
import { codeTools } from '../../../../../packages/agent/runtime/src/tools/code.ts'
import { notifyTools } from '../../../../../packages/agent/runtime/src/tools/notify.ts'
import { openTools } from '../../../../../packages/agent/runtime/src/tools/open.ts'
import type { RunTool } from '../../../../../packages/agent/runtime/src/tools/scope.ts'
import * as views from '../../../../../packages/agent/runtime/src/tools/views.ts'
import { SavedProcedures } from '../../../../../packages/agent/runtime/src/tools/snapshots.ts'
import { procedureSuggestions } from '../../search/suggestions.ts'
import { manifest } from '@vivid/skills'
import { builtins, catalogue, procedures, summary } from './index.ts'

/** Registration factories are the same ones used by Vivid, without running a tool or model. */
const runner: RunTool = () => Promise.resolve({ output: {}, terminate: false })
const registered = new Set(
  [
    ...libraryTools(runner),
    ...connectionTools(runner),
    ...askTools(runner),
    ...memoryTools(runner),
    // The directory is never opened here: only the tools' names are read.
    ...noteTools(runner, 'unused'),
    ...skillTools(runner),
    ...routineTools(runner),
    commandDefinition(runner),
    ...pictureTools(runner),
    ...codeTools(runner),
    ...documentTools(runner),
    ...showTools(),
    ...openTools(runner),
    ...notifyTools(runner),
  ].map((tool) => tool.name),
)

/** Flue injects this native tool for mounts; the package's real-runtime test verifies it and every needs entry. */
registered.add('activate_skill')

/** Ready and pending accounts demonstrate that a service name alone cannot make an offer runnable. */
const connection = (serviceName: string, state: ConnectionState) =>
  Connection.make({
    id: ConnectionId.make('MARK-connection'),
    service: ServiceId.make('MARK-service'),
    serviceName,
    mark: null,
    label: 'Work',
    ownership: ConnectionOwnership.cases.Shared.make({}),
    state,
    createdAt: 0,
  })

describe('shipped procedure catalogue', () => {
  it('uses registered tools and projects no record handles', () => {
    for (const procedure of procedures) {
      expect(procedure.about).not.toMatch(/the Person|^When\b|`/iu)
      expect(procedure.about.length).toBeLessThanOrEqual(300)
      for (const tool of registered)
        expect(procedure.about).not.toMatch(new RegExp(`\\b${tool}\\b`, 'u'))
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
    }
  })

  it('preserves display names, descriptions and wire identities', () => {
    expect(new Set(manifest.map((entry) => entry.runtimeName)).size).toBe(manifest.length)
    for (const procedure of procedures) {
      expect(procedure.runtimeName).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      expect(procedure.runtimeName.length).toBeLessThanOrEqual(64)
      const record = builtins.find((item) => item.name === procedure.displayName)
      expect(record).toMatchObject({
        id: `builtin:${procedure.displayName.toLowerCase().replaceAll(' ', '-')}`,
        useWhen: procedure.useWhen,
        about: procedure.about,
        createdAt: Date.UTC(2026, 9, 2),
        updatedAt: Date.UTC(2026, 9, 2),
      })
    }
    expect(views.skills(builtins)).toEqual(SavedProcedures.cases.Available.make({ skills: [] }))
  })

  it('keeps every built-in alongside legacy saved name collisions without override claims', () => {
    const original = builtins.find((item) => item.name === 'Deep research')
    if (original === undefined) expect.fail('Release must contain Deep research')
    for (const scope of [SkillScope.cases.Personal.make({}), SkillScope.cases.Company.make({})]) {
      const saved = Skill.make({
        ...original,
        id: SkillId.make('MARK-private-skill'),
        name: ' DEEP RESEARCH ',
        scope,
        origin: SkillOrigin.cases.Saved.make({
          createdBy: PersonSummary.make({
            id: PersonId.make('MARK-person'),
            name: 'Ada',
            image: null,
          }),
        }),
      })
      const effective = catalogue([saved])
      expect(effective).toHaveLength(builtins.length + 1)
      expect(effective).toContain(original)
      expect(summary(saved)).toBe(saved.useWhen)
      expect(views.skills(effective)).toEqual(
        SavedProcedures.cases.Available.make({
          skills: [{ name: 'deep-research-saved', useWhen: saved.useWhen }],
        }),
      )
      expect(JSON.stringify(views.skills(effective))).not.toContain(saved.id)
    }
  })

  it('offers connected work only with all dependencies ready, otherwise the four starters', () => {
    const fallback = procedureSuggestions([])
    expect(fallback).toHaveLength(4)
    for (const suggestion of fallback) {
      expect(suggestion.reason).not.toMatch(/^When\b|the Person|`|save_skill|read_page/iu)
      const builtin = builtins.find((skill) => skill.name === suggestion.text)
      if (builtin === undefined) expect.fail('Suggestion must name a shipped skill')
      expect(suggestion.reason).toBe(builtin.about)
    }
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
