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
import {
  askTools,
  codeTools,
  connectionTools,
  documentTools,
  libraryTools,
  memoryTools,
  noteTools,
  notifyTools,
  pictureTools,
  SavedProcedures,
  skillTools,
  views,
  watchTools,
} from '@vivid/agent-runtime'
import type { RunTool } from '@vivid/agent-runtime/scope'
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
    ...pictureTools(runner),
    ...codeTools(runner),
    ...documentTools(runner),
    ...notifyTools(runner),
    ...watchTools(runner),
  ].map((tool) => tool.name),
)

/** Flue injects this native tool for mounts; the package's real-runtime test verifies it and every needs entry. */
registered.add('activate_skill')

/** Flue's own shell tool, mounted by the Computer's sandbox; the same real-runtime test verifies it. */
registered.add('bash')

/** Ready and pending accounts demonstrate that a service name alone cannot make an offer runnable. */
const connection = (serviceName: string, state: ConnectionState) =>
  Connection.make({
    id: ConnectionId.make('MARK-connection'),
    service: ServiceId.make('MARK-service'),
    serviceName,
    mark: null,
    name: 'Work',
    identity: null,
    account: `${serviceName} (Work)`,
    origin: 'Catalogue',
    ownership: ConnectionOwnership.cases.Shared.make({}),
    state,
    createdAt: 0,
  })

describe('shipped procedure catalogue', () => {
  it('uses registered tools and projects no record handles', () => {
    for (const procedure of procedures) {
      for (const tool of procedure.needs)
        expect(registered.has(tool), `${procedure.name}: ${tool}`).toBe(true)
      // Executable instructions must use available tools and declare their readiness needs.
      for (const [, tool] of procedure.instructions.matchAll(/`([a-z_]+)`/g)) {
        if (tool === undefined) expect.fail('Expected a captured tool name')
        expect(registered.has(tool), `${procedure.name}: ${tool}`).toBe(true)
        expect(procedure.needs, `${procedure.name}: ${tool}`).toContain(tool)
      }
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
        useWhen: procedure.useWhen,
        about: procedure.about,
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

  it('offers connected work only with all dependencies ready, otherwise the starter procedures', () => {
    const fallback = procedureSuggestions([])
    expect(fallback.map((suggestion) => suggestion.text)).toEqual([
      'Connect a service',
      'Remember and correct preferences',
      'Learn how we do this',
    ])
    for (const suggestion of fallback) {
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
