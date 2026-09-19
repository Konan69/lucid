import { Effect, Schema } from 'effect'
import { emptyResponse, request, type ClientRequestFailed } from './request'

/* Routines: what Vivid repeats for you. Some you wrote; some started as
   templates from the gallery — published by Vivid or by other teams, sold,
   with a cut of every sale going to the author. */

export type Program<Value> = Effect.Effect<Value, ClientRequestFailed>

export type RoutineRun = {
  id: string
  conversationId: string
  status: 'running' | 'succeeded' | 'failed'
  startedAt: number
  finishedAt: number | null
  output: string | null
  error: string | null
}

export type ScheduledRoutine = {
  id: string
  name: string
  prompt: string
  cron: string
  timezone: string
  enabled: boolean
  lastMissedAt: number | null
  nextRunAt: number | null
  runs: RoutineRun[]
}

export type RoutineInput = {
  readonly name: string
  readonly prompt: string
  readonly cron: string
  readonly timezone: string
}

const RoutineRunSchema = Schema.Struct({
  id: Schema.String,
  conversationId: Schema.String,
  status: Schema.Literals(['running', 'succeeded', 'failed']),
  startedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
})
const ScheduledRoutineSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  cron: Schema.String,
  timezone: Schema.String,
  enabled: Schema.Boolean,
  lastMissedAt: Schema.NullOr(Schema.Number),
  nextRunAt: Schema.NullOr(Schema.Number),
  runs: Schema.mutable(Schema.Array(RoutineRunSchema)),
})
const RoutinesResponseSchema = Schema.fromJsonString(
  Schema.Struct({
    routines: Schema.mutable(Schema.Array(ScheduledRoutineSchema)),
  }),
)
const RoutineResponseSchema = Schema.fromJsonString(
  Schema.Struct({ routine: ScheduledRoutineSchema }),
)
const decodeRoutinesResponse = Schema.decodeUnknownSync(RoutinesResponseSchema)
const decodeRoutineResponse = Schema.decodeUnknownSync(RoutineResponseSchema)

/** Encodes one Routine mutation at the Fetch boundary. */
function routineRequest(method: 'POST' | 'PATCH', input: RoutineInput): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }
}

/** Reads all Routines and their recent Runs. */
export const load = Effect.fn('Routines.load')(function* () {
  const response = yield* request('/api/routines', decodeRoutinesResponse)
  return response.routines
})

/** Creates one Routine. */
export const create = Effect.fn('Routines.create')(function* (input: RoutineInput) {
  const response = yield* request(
    '/api/routines',
    decodeRoutineResponse,
    routineRequest('POST', input),
  )
  return response.routine
})

/** Updates one Routine's editable fields. */
export const update = Effect.fn('Routines.update')(function* (id: string, input: RoutineInput) {
  const response = yield* request(
    `/api/routines/${id}`,
    decodeRoutineResponse,
    routineRequest('PATCH', input),
  )
  return response.routine
})

/** Pauses or resumes one Routine. */
export const setEnabled = Effect.fn('Routines.setEnabled')(function* (
  id: string,
  enabled: boolean,
) {
  const response = yield* request(`/api/routines/${id}`, decodeRoutineResponse, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  return response.routine
})

/** Starts one Routine immediately. */
export const runNow = Effect.fn('Routines.runNow')(function* (id: string) {
  yield* request(`/api/routines/${id}/run`, emptyResponse, { method: 'POST' })
})

/** Deletes one Routine and its Run history. */
export const remove = Effect.fn('Routines.remove')(function* (id: string) {
  yield* request(`/api/routines/${id}`, emptyResponse, { method: 'DELETE' })
})

export type RoutineTemplate = {
  id: string
  name: string
  summary: string
  trigger: string
  actions: string[]
  /** Who published it. "vivid" = Vivid original. */
  publisher: string
  brandColor: 'accent' | 'working' | 'approve' | 'success'
  price: string
  /** Sales to date — social proof, Drive-style plainness. */
  installs: string
  rating: string
  /** Cut the author keeps on each sale. */
  authorCut?: string
}

export const templates: RoutineTemplate[] = [
  {
    id: 'tpl-weekly-numbers',
    name: 'Weekly numbers',
    summary:
      'One metric, every week, three lines. Signups, revenue, tickets — point it at anything you count.',
    trigger: 'Weekly, your pick of day and time',
    actions: [
      'Pull the metric',
      'Compare to the prior period',
      'Post a summary — escalate only past your threshold',
    ],
    publisher: 'Vivid',
    brandColor: 'accent',
    price: 'Free',
    installs: '41k',
    rating: '4.9',
  },
  {
    id: 'tpl-contract-watch',
    name: 'Contract renewal watch',
    summary:
      'Never miss a renewal. Vivid reads your contracts and starts the renegotiation conversation 60 days out.',
    trigger: 'Daily scan, alerts 60 days before renewal',
    actions: [
      'Read contract dates from your files',
      'Alert 60, 30, and 7 days out',
      'Draft the renewal email for your approval',
    ],
    publisher: 'Vivid',
    brandColor: 'accent',
    price: '£3/mo',
    installs: '12k',
    rating: '4.8',
  },
  {
    id: 'tpl-tender-triage',
    name: 'Tender triage',
    summary:
      'For ops teams that bid on contracts. Vivid reads each tender, scores fit, and drafts the compliance checklist.',
    trigger: 'When a new tender lands in the shared folder',
    actions: [
      'Read the tender end to end',
      'Score fit against your capability matrix',
      'Draft the compliance checklist and own the gaps',
    ],
    publisher: 'Whitehall Works',
    brandColor: 'working',
    price: '£9/mo',
    installs: '1.8k',
    rating: '4.7',
    authorCut: '70%',
  },
  {
    id: 'tpl-brand-guard',
    name: 'Brand guard',
    summary:
      'For marketing teams. Every deck or page that mentions the brand gets checked against the guidelines before it ships.',
    trigger: 'When a file is added to the brand review folder',
    actions: [
      'Check logos, colors, and tone against the guidelines',
      'Leave inline notes on what to fix',
      'Mark it ready when it passes',
    ],
    publisher: 'Studio Norr',
    brandColor: 'approve',
    price: '£5/mo',
    installs: '3.4k',
    rating: '4.6',
    authorCut: '70%',
  },
  {
    id: 'tpl-intake',
    name: 'Client intake to file',
    summary:
      'For legal and admin. New client form comes in, Vivid files it, runs conflicts, and opens the matter folder.',
    trigger: 'When an intake form is submitted',
    actions: [
      'File the intake form',
      'Run the conflicts check',
      'Open the matter folder and brief the team',
    ],
    publisher: 'Kestrel Legal Ops',
    brandColor: 'success',
    price: '£12/mo',
    installs: '940',
    rating: '4.9',
    authorCut: '70%',
  },
  {
    id: 'tpl-close-week',
    name: 'Close the week',
    summary:
      "Friday afternoon, Vivid closes your week: chases what's stuck, archives what's done, and writes the Monday brief.",
    trigger: 'Every Friday at 4pm',
    actions: [
      'Chase every conversation waiting over 3 days',
      'Archive settled work',
      'Write the Monday brief from what moved',
    ],
    publisher: 'Vivid',
    brandColor: 'accent',
    price: 'Free',
    installs: '28k',
    rating: '4.8',
  },
]
