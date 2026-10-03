import { describe, expect, it } from 'vitest'
import { Predicate, Schema } from 'effect'
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
  ConnectionTool,
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
import { SavedProcedures, VividContext } from './snapshots.ts'
import * as views from './views.ts'
import { askTools } from './ask.ts'
import { computerDefinitions } from './computer.ts'
import { connectionTools } from './connections.ts'
import { libraryTools } from './library.ts'
import { memoryTools } from './memory.ts'
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
const tool = ConnectionTool.make({
  connectionId: ConnectionId.make(reference),
  account: 'Mail (Work)',
  name: 'read_mail',
  description: 'Read mail',
  effect: 'read',
  input: {
    type: 'object',
    properties: { query: { type: 'string' }, email: { type: 'string' }, id: { type: 'string' } },
  },
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
      views.forgotten(memory),
      views.corrected(memory, { ...memory, id: MemoryId.make('MARK-replacement') }),
      views.memoryChoices([memory, memory]),
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
        brief: `Review before signing. Legacy note: ${reference}.`,
        skills: [skill, skill],
        timezone: 'Africa/Lagos',
        name: 'Vivid',
      }),
    )
    expect(context).not.toMatch(/MARK-|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|"id"/iu)
    expect(context).toContain('review-agreement-2')
    expect(json).toContain('admin@example.test')
    expect(views.tools({ tools: [tool], unconnected: [] }).tools[0]).toHaveProperty(
      'input',
      tool.input,
    )
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
  if (value.entries !== undefined && isRecord(value.entries)) {
    for (const field of Object.keys(value.entries)) expect(field).not.toMatch(/^(?:id)$|Id$/u)
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
    computerDefinitions,
    connectionTools,
    libraryTools,
    memoryTools,
    routineTools,
    skillTools,
  ]
  for (const factory of groups)
    for (const definition of factory(inspectionOnly))
      inspectSchema(schemaDocument(JSON.stringify(definition.input)))
})
