import { describe, expect, it } from 'vitest'
import { Option, Predicate, Schema } from 'effect'
import {
  LibraryItemId,
  Memory,
  MemoryId,
  MemoryScope,
  PersonId,
  PersonSummary,
  Routine,
  RoutineId,
  RoutineTrigger,
  Skill,
  SkillId,
  SkillScope,
  SkillOrigin,
  ThreadId,
  ConnectionId,
  Service,
  ServiceId,
  ServiceAuthorization,
  DiscoveredTool,
  LibraryFolderId,
  Occurrence,
  OccurrenceId,
  RunId,
  ApprovalId,
  InputRequestId,
  InputRequest,
  InputRequestState,
  ConnectionRequestMessage,
} from '@vivid/contracts'
import { contextInstruction } from '../context.ts'
import { NoteFile, NoteIndex, NoteLine } from '../notes.ts'
import { Remembered, SavedProcedures, VividContext } from './snapshots.ts'
import * as views from './views.ts'
import { askTools } from './ask.ts'
import { commandDefinition, pictureTools } from './computer.ts'
import { connectionTools } from './connections.ts'
import { libraryTools } from './library.ts'
import { memoryTools } from './memory.ts'
import { projectTools } from './projects.ts'
import { routineTools } from './routines.ts'
import { skillTools } from './skills.ts'
import type { RunTool } from './scope.ts'

const reference = '37e21f26-63ed-4075-aad1-0118929da0ac'
const person = PersonSummary.make({
  id: PersonId.make('MARK-person'),
  name: 'Ada',
  image: 'https://example.test/MARK-image.png',
})
const skill = Skill.make({
  id: SkillId.make(reference),
  name: 'Review agreement',
  about: 'Reviews your agreement before you sign.',
  useWhen: 'Before signing',
  instructions: 'Read the terms.',
  scope: SkillScope.cases.Personal.make({}),
  origin: SkillOrigin.cases.Saved.make({ createdBy: person }),
  createdAt: 0,
  updatedAt: 0,
})
const memory = Memory.make({
  id: MemoryId.make(reference),
  kind: 'preference',
  content: 'Review in the morning.',
  scope: MemoryScope.cases.Thread.make({
    threadId: ThreadId.make('MARK-thread'),
    title: 'Agreement',
  }),
  learnedIn: ThreadId.make('MARK-learned'),
  learnedFrom: person,
  createdAt: 0,
  updatedAt: 0,
})
const occurrence = Occurrence.make({
  id: OccurrenceId.make(reference),
  routineId: RoutineId.make('MARK-routine'),
  threadId: ThreadId.make('MARK-thread'),
  submissionId: RunId.make('MARK-run'),
  status: 'succeeded',
  startedAt: 0,
  finishedAt: 1000,
  output: 'MARK-output',
  error: null,
})
const routine = Routine.make({
  id: RoutineId.make(reference),
  name: 'Review each morning',
  prompt: 'Review the agreement.',
  trigger: RoutineTrigger.cases.Schedule.make({ cron: '0 9 * * *', timezone: 'Africa/Lagos' }),
  libraryFolderId: LibraryFolderId.make('MARK-folder'),
  enabled: true,
  nextExpectedAt: 1000,
  lastMissedAt: null,
  createdAt: 0,
  updatedAt: 0,
  nextRunAt: 1000,
  runs: [occurrence],
})
const service = Service.make({
  id: ServiceId.make('MARK-service'),
  name: 'Mail',
  description: 'Read mail',
  mark: 'MARK-mark',
  authorization: ServiceAuthorization.cases.None.make({}),
})
const tool = DiscoveredTool.make({
  connectionId: ConnectionId.make(reference),
  account: 'Mail (Work)',
  name: 'read_mail',
  description: 'Read mail',
  effect: 'read',
  call: 'accounts["Mail (Work)"].read_mail',
  signature:
    '(input: {email?: string; id?: string; query?: string}, about: {summary: string; rationale: string}) => Promise<{ok: true; output: Json} | {ok: false; reason: string}>',
})

/** This checks actual model-facing projections, including context, not acceptance by wire schemas. */
describe('model views', () => {
  it('projects every ordinary view without any fixture reference or UUID', () => {
    const output = [
      views.skills([skill, skill]),
      views.skill(skill, 'review-agreement-2'),
      views.skillSummary(skill, 'Review agreement'),
      views.tools({ tools: [tool], unconnected: [service] }),
      views.memories([
        memory,
        { ...memory, scope: MemoryScope.cases.Person.make({}) },
        { ...memory, scope: MemoryScope.cases.Company.make({}) },
      ]),
      views.remembered(memory),
      views.passages([
        {
          chunkId: 'MARK-chunk',
          documentId: LibraryItemId.make(reference),
          filename: 'Agreement.pdf',
          page: 2,
          text: 'Signature required',
          score: 1,
        },
      ]),
      views.routine(routine, routine.name),
      views.routines([routine]),
      views.routine({ ...routine, trigger: RoutineTrigger.cases.Webhook.make({}) }, routine.name),
      views.command({
        exitCode: 0,
        output: `Saved ${reference}, admin@example.test and https://example.test/screen.png`,
        truncated: false,
      }),
      views.browse({
        address: 'https://example.test',
        tabs: [{ title: 'Agreement', address: 'https://example.test', showing: true }],
        title: 'Agreement',
        outline: 'Signed',
        truncated: false,
      }),
    ]
    const json = JSON.stringify(output)
    expect(json).not.toMatch(/MARK-|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu)
    const context = contextInstruction(
      VividContext.make({
        memory: Remembered.cases.Notes.make({
          index: NoteIndex.make({
            lines: [
              NoteLine.make({
                file: NoteFile.make('review-before-signing.md'),
                kind: 'preference',
                description: `Review before signing.\nLegacy note: ${reference}.`,
              }),
              NoteLine.make({
                file: NoteFile.make('invoices-on-fridays.md'),
                kind: 'decision',
                description: 'Invoices go out on Fridays',
              }),
            ],
            more: true,
          }),
        }),
        skills: [skill, skill],
        timezone: 'Africa/Lagos',
        // 16:00 UTC is 17:00 in Lagos (UTC+1, no daylight saving).
        asOf: Option.some(Date.UTC(2026, 9, 4, 16, 0)),
        apps: ['GIMP', 'LibreOffice Calc'],
        integrations: ['DeepWiki', `Mail ${reference}`],
        name: 'Vivid',
      }),
    )
    expect(context).not.toMatch(/MARK-|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|"id"/iu)
    expect(context).toContain('review-agreement-2')
    // Each note is one line: its file name, kind and description, with an identifier removed and
    // a line break inside a description folded so it cannot start a line of its own.
    expect(context).toContain(
      '- review-before-signing.md (preference): Review before signing. Legacy note: ',
    )
    expect(context).toContain('- invoices-on-fridays.md (decision): Invoices go out on Fridays')
    expect(context).toContain('Older notes are not listed here.')
    // A failed read is told to the model as such, never as an empty memory.
    const unread = contextInstruction(
      VividContext.make({
        memory: Remembered.cases.Unavailable.make({}),
        skills: [],
        timezone: 'UTC',
        asOf: Option.none(),
        apps: [],
        integrations: [],
        name: 'Vivid',
      }),
    )
    expect(unread).toContain('Your notes could not be read for this response.')
    expect(unread).not.toContain('What you remember')
    // The clock is the last thing in the context: the Person's local hour, and the same instant in UTC.
    expect(
      context.endsWith(
        'Current local date and time (Africa/Lagos, locked to the hour): Sunday, 4 October 2026 at 17:00. UTC instant: 2026-10-04T16:00Z. This is the start of the current hour; the minutes are not known. Use it as the clock for today, tomorrow, deadlines and anything relative to now.',
      ),
    ).toBe(true)
    expect(context).toContain('"apps":["GIMP","LibreOffice Calc"]')
    // Connected services reach the model by name, with any identifier in a name removed.
    expect(context).toContain('"integrations":["DeepWiki","Mail ')
    expect(json).toContain('admin@example.test')
    expect(views.tools({ tools: [tool], unconnected: [] }).tools[0]).toHaveProperty(
      'signature',
      tool.signature,
    )
  })
  it('omits rewritten account labels while preserving exact callable names', () => {
    for (const account of [`Mail ${reference}`, 'Mail https://example.test/picture.png']) {
      const hidden = DiscoveredTool.make({
        ...tool,
        account,
        call: `accounts[${JSON.stringify(account)}].read_mail`,
      })
      const view = views.tools({ tools: [hidden, tool], unconnected: [] })
      expect(view.tools).toEqual([
        expect.objectContaining({ account: tool.account, call: tool.call }),
      ])
      // The tool that cannot be shown is counted, so the model can say it exists.
      expect(view.withheld).toBe(1)
    }
  })

  it('projects call expressions and signatures without provider schema documents', () => {
    const result = views.tools({ tools: [tool], unconnected: [] }).tools[0]
    expect(result).toHaveProperty('call', tool.call)
    expect(result).toHaveProperty('signature', tool.signature)
    expect(result).not.toHaveProperty('input')
  })
  it('reports unavailable summaries explicitly while a successful built-in-only catalogue has no saved procedures', () => {
    const unavailable = views.skills([])
    expect(SavedProcedures.guards.Unavailable(unavailable)).toBe(true)
    expect(JSON.stringify(unavailable)).toContain('Saved procedures are unavailable right now')
    const builtin = {
      id: SkillId.make('builtin:deep-research'),
      name: 'Deep research',
      useWhen: 'When research needs sources',
      createdAt: 0,
    }
    expect(views.skills([builtin])).toEqual(SavedProcedures.cases.Available.make({ skills: [] }))
  })

  it('keeps contact addresses in Person-authored content, including UUID-shaped mailboxes', () => {
    const detail = `Contact ${reference}@example.test or ada@example.test; internal reference ${reference}.`
    expect(views.modelText(detail)).toBe(
      `Contact ${reference}@example.test or ada@example.test; internal reference [reference].`,
    )
  })
  it('keeps exactly the documented client card references', () => {
    const request = InputRequest.make({
      id: InputRequestId.make(reference),
      threadId: ThreadId.make('MARK-thread'),
      runId: null,
      askedOf: person,
      question: 'Send?',
      options: [],
      allowsOwnAnswer: true,
      state: InputRequestState.cases.Waiting.make({}),
      createdAt: 0,
    })
    const cards = [
      views.approval({ approvalId: ApprovalId.make(reference), summary: 'Send the draft' }),
      views.inputRequest(request),
      views.connectionRequest(
        ConnectionRequestMessage.make({
          kind: 'connection-request',
          service: service.id,
          serviceName: service.name,
          reason: 'Read mail',
          ready: false,
        }),
      ),
    ]
    expect(cards[0]).toMatchObject({ approvalId: reference })
    expect(cards[1]).toMatchObject({ requestId: reference })
    expect(cards[2]).toMatchObject({ service: 'MARK-service' })
    const visible = cards.map((card) =>
      Object.fromEntries(
        Object.entries(card).filter(
          ([key]) => !['approvalId', 'requestId', 'service'].includes(key),
        ),
      ),
    )
    expect(JSON.stringify(visible)).not.toMatch(
      /MARK-|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu,
    )
  })
})

const inspectionOnly: RunTool = () =>
  Promise.reject(new Error('Schema inspection must never execute a tool.'))

/** Valibot schema graphs contain shared nodes and callbacks; walk values without invoking either. */
function inspectSchema(value: Schema.Json) {
  if (isList(value)) {
    for (const entry of value) inspectSchema(entry)
    return
  }
  if (!isRecord(value)) return
  expect(value.type).not.toBe('uuid')
  const fields = value.entries === undefined ? value.properties : value.entries
  if (fields !== undefined && isRecord(fields)) {
    for (const field of Object.keys(fields)) expect(field).not.toMatch(/^(?:id)$|Id$/u)
  }
  for (const entry of Object.values(value)) inspectSchema(entry)
}

/** Serialized Valibot schemas retain validators and keys while discarding executable callbacks. */
const schemaDocument = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

/** Preserve the readonly JSON array contract during recursive schema inspection. */
function isList(value: Schema.Json): value is Schema.JsonArray {
  return Array.isArray(value)
}

/** Inspect only decoded JSON records, never arbitrary objects or callbacks. */
function isRecord(value: Schema.Json): value is Schema.JsonObject {
  return Predicate.isObject(value) && !isList(value)
}

/** All mounted tools are inspected, including nested browser actions and input-request choices. */
it('has no identifier key or UUID validator in any model tool input', () => {
  const groups = [
    askTools,
    connectionTools,
    libraryTools,
    memoryTools,
    routineTools,
    projectTools,
    skillTools,
  ]
  inspectSchema(schemaDocument(JSON.stringify(commandDefinition(inspectionOnly).input)))
  for (const native of pictureTools(inspectionOnly))
    inspectSchema(schemaDocument(JSON.stringify(native.parameters)))
  for (const factory of groups)
    for (const definition of factory(inspectionOnly))
      inspectSchema(schemaDocument(JSON.stringify(definition.input)))
})
