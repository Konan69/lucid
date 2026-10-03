import * as NodeCrypto from 'node:crypto'
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
import { skillTools } from '../../../../../packages/agent/runtime/src/tools/skills.ts'
import { routineTools } from '../../../../../packages/agent/runtime/src/tools/routines.ts'
import {
  computerDefinitions,
  desktopModelTool,
} from '../../../../../packages/agent/runtime/src/tools/computer.ts'
import { documentTools } from '../../../../../packages/agent/runtime/src/tools/documents.ts'
import { showTools } from '../../../../../packages/agent/runtime/src/tools/show.ts'
import { codeTools } from '../../../../../packages/agent/runtime/src/tools/code.ts'
import type { RunTool } from '../../../../../packages/agent/runtime/src/tools/scope.ts'
import * as views from '../../../../../packages/agent/runtime/src/tools/views.ts'
import { procedureSuggestions } from '../../search/suggestions.ts'
import { builtinNames, manifest } from '../../../../../packages/agent/skills/src/manifest.ts'
import { builtins, catalogue, procedures, summary } from './index.ts'

/** SHA-256 evidence captured from the 22 TypeScript bodies before their phase-one move. */
const originalBodies = {
  'connect-a-service': 'd5079daa98ce168239979a706244d3477e1bfa97f0117059b9b734c0f230900d',
  'work-in-a-signed-in-browser': '4dc40499ff884bad196036ab335b5257d63c6863eccc047fe0c8464081607d9d',
  'deep-research': 'cde6ceae07d5bb62d81fb60f34cfbae8ab41deb273cabe172aeb2ac08c93b7f1',
  'triage-my-inbox': '7e65a66518d0c48977625a3840fa8724071c5f6d45c945e11fc340873f81fa4f',
  'draft-a-reply': 'e82edfa7dd5b6f3dcbaccb7738dc8ce2b46e99b11f8225007aa6ed190580d5f1',
  'morning-brief': 'efb62f8a2e55a3037d7ea4ab647eff753e455e61405f87413c69d87347b42c80',
  'find-time-and-schedule': 'e0e6a0dffdb5dcbecc74a13df4668cd2495818dec82a4c728fe4eb15de4d4722',
  'prepare-for-a-meeting': '2c9435e63a27d4fe74faf39efc33f5b8dfe454852329c955dfdd434e7ec64eb5',
  'chase-an-outcome': '1ba11e7c47308709335970ef119ef854eff92d1039969f64e491f2d3e8882f30',
  'watch-a-useful-signal': 'fc2aecdc194730b0fd6750b2cb88a0479023ec27838f27655c82bf6f2e10cf34',
  'remember-and-correct-preferences':
    '2fa516bb1d6c4bc9d83fd6dd1042eed5a2f1396d0c2baecc481b1c6763b86754',
  'learn-how-we-do-this': 'b839e2a2cdc5677e633d380b969a132359000f30e0b3be625ac29bef0f96b959',
  'write-a-document': '99b975b8e9a7ae934fa61409e9e4ee9a42ae859fe26c551b6013c90e53ddfa5c',
  'check-a-deliverable': '4649e97543133f41275e38044c2936f72c10d086a56d291a6e2b69b6b40148ca',
  'wide-research': 'ddb4a32ff78ec02c355e34d6b413f4b5663e2872758ee2205bd2ef6bf7230a8f',
  'plan-a-trip': 'a213479743189a183578b2d8a49dd2103d9312061db20c3f998cb914cca1f4d7',
  'shop-for-something': '7fa205e77b26cfb1370a9ab19edb7e2fdba5bb964985d8a760a66f44956e4d08',
  'find-a-place': '8e7106d15488d889a3989ab6cc29e3aa12ae47ee962912adca08e82daea2168f',
  'make-a-booking': 'b9bb43ca78e64779174e7c264a2360aa64e5f8e5bbe47cf0510f15e4735c8268',
  'forget-something': 'bea5b3278e5d7bd7760ce0e4e565155768cdd5b0b74ed91519940bfa13a22546',
  'what-vivid-can-do': 'e29b3407ad65221591dd8f8f109ed19b44a6669145cf9e495c50ab4ed6444ba8',
  'find-pictures': 'b99513113f6f5038d0b053bae838de3c9b52938fe0146a0e7e1ca56c1b40f54a',
} as const

/** Registration factories are the same ones used by Vivid, without running a tool or model. */
const runner: RunTool = () => Promise.resolve({ output: {}, terminate: false })
const registered = new Set(
  [
    ...libraryTools(runner),
    ...connectionTools(runner),
    ...askTools(runner),
    ...memoryTools(runner),
    ...skillTools(runner),
    ...routineTools(runner),
    ...computerDefinitions(runner),
    desktopModelTool(runner),
    ...codeTools(runner),
    ...documentTools(runner),
    ...showTools(),
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
    expect(procedures).toHaveLength(22)
    for (const procedure of procedures) {
      expect(procedure.about).not.toMatch(/the Person|^When\b|`/iu)
      expect(procedure.about.length).toBeLessThanOrEqual(300)
      for (const tool of registered)
        expect(procedure.about).not.toMatch(new RegExp(`\\b${tool}\\b`, 'u'))
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

  it('preserves every migrated body, display name, description and wire identity', () => {
    expect(new Set(manifest.map((entry) => entry.runtimeName)).size).toBe(22)
    for (const procedure of procedures) {
      expect(NodeCrypto.createHash('sha256').update(procedure.instructions).digest('hex')).toBe(
        originalBodies[procedure.runtimeName],
      )
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
    expect(views.skills(builtins)).toEqual([])
    expect(builtinNames(builtins)).toHaveLength(22)
    expect(builtinNames([])).toEqual([])
  })

  it('mounts only public built-ins left after a Person or Company saved-name override', () => {
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
      expect(builtinNames(effective)).not.toContain('deep-research')
      expect(builtinNames(catalogue([]))).toContain('deep-research')
      expect(views.skills(effective)).toEqual([{ name: 'DEEP RESEARCH', useWhen: saved.useWhen }])
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
