import type { FlueConversationMessage, FlueConversationSettlement } from '@flue/sdk'
import { describe, expect, it } from '@effect/vitest'
import { Person, PersonId, RunId, ThreadId, Workspace } from '@vivid/contracts'
import { RuntimeUnavailable } from '@vivid/contracts/rpc'
import { Effect, Layer, Logger, Option, Ref } from 'effect'
import { HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { Audit } from '../audit/record.ts'
import { silentChangesLayer } from '../live/changes.ts'
import { Runtime } from '../runtime/client.ts'
import { StoredThread } from '../threads/access.ts'
import {
  MemoryCandidate,
  MemoryExtraction,
  MemoryRelation,
  type MemoryExchange,
} from './extract.ts'
import { Learning, learningLayer, type LearningInput } from './learn.ts'
import { MemoryAccess } from './store.ts'

const input: LearningInput = {
  thread: StoredThread.make({
    titleSource: 'Person',
    id: ThreadId.make('MARK-thread'),
    personId: PersonId.make('MARK-person'),
    companyId: null,
    title: 'Meetings',
    preview: '',
    updatedAt: 1,
    archived: false,
    audience: 'private',
    projectId: null,
  }),
  person: Person.make({
    id: PersonId.make('MARK-person'),
    name: 'Dami',
    email: 'dami@example.test',
  }),
  said: 'Morning',
  replied: 'Noted.',
  runId: RunId.make('MARK-current'),
}
const question = 'When do you prefer meetings?'

/** The fixture uses installed Flue snapshot types, including real signal attribution and non-text parts. */
function message(
  submissionId: string,
  role: 'user' | 'assistant',
  text: string,
): FlueConversationMessage {
  return {
    id: `MARK-${submissionId}-${role}`,
    submissionId,
    role,
    purpose: role,
    display: 'visible',
    parts: [{ type: 'text', text, state: 'done' }],
  }
}

/** Every completed exchange has the same submission correlation Flue's history emits. */
const completed = (submissionId: string): FlueConversationSettlement => ({
  submissionId,
  outcome: 'completed',
})

/** Exercise the existing Runtime read and the actual history decoder; transport metadata stays out of extraction. */
function history(messages: FlueConversationMessage[], settlements: FlueConversationSettlement[]) {
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      HttpClientRequest.get('http://runtime.test/agents/vivid/MARK-thread?view=history'),
      new Response(
        JSON.stringify({
          v: 1,
          conversationId: 'MARK-conversation',
          offset: 'MARK-offset',
          messages,
          settlements,
        }),
      ),
    ),
  )
}

/** Controlled test Layers prove production orchestration independently of model availability.
 * The extraction substitute needs the meeting question to interpret the fragment; a complete
 * statement stands on its own. Captured candidates are the write-side observable receipt. */
const learn = Effect.fn('MemoryTest.learn')(function* (
  delivery: LearningInput,
  read: Effect.Effect<HttpClientResponse.HttpClientResponse, RuntimeUnavailable>,
) {
  const exchanges = yield* Ref.make<ReadonlyArray<MemoryExchange>>([])
  const saved = yield* Ref.make<ReadonlyArray<MemoryCandidate>>([])
  const warnings: string[] = []
  const extraction = Layer.mock(MemoryExtraction, {
    extract: Effect.fn('MemoryTest.extract')(function* ({ exchange }) {
      yield* Ref.update(exchanges, (before) => [...before, exchange])
      if (exchange.message === 'Morning' && exchange.previousReply !== question) return []
      return [
        MemoryCandidate.make({
          shouldStore: true,
          kind: 'preference',
          content: 'Dami prefers morning meetings.',
          aliases: [],
          relation: MemoryRelation.cases.new.make({}),
          forCompany: false,
        }),
      ]
    }),
  })
  const access = Layer.mock(MemoryAccess, {
    actorFor: Effect.fn('MemoryTest.actor')((_thread, person) =>
      Effect.succeed({
        person,
        workspace: Workspace.cases.Personal.make({}),
        by: 'vivid' as const,
        threadId: Option.some(delivery.thread.id),
      }),
    ),
    recall: Effect.fn('MemoryTest.recall')(() => Effect.succeed([])),
    learn: Effect.fn('MemoryTest.save')(function* (_actor, candidate) {
      yield* Ref.update(saved, (before) => [...before, candidate])
      return Option.none()
    }),
  })
  const runtime = Layer.mock(Runtime, {
    read: Effect.fn('MemoryTest.history')((request) => {
      expect(request).toEqual({
        threadId: delivery.thread.id,
        suffix: '',
        search: '?view=history',
        accept: 'application/json',
      })
      return read
    }),
  })
  yield* Effect.gen(function* () {
    yield* (yield* Learning).afterRun(delivery)
  }).pipe(
    Effect.provide(learningLayer),
    Effect.provide([
      access,
      extraction,
      runtime,
      silentChangesLayer,
      Layer.mock(Audit, { record: Effect.fn('MemoryTest.audit')(() => Effect.void) }),
      Logger.layer([Logger.make(({ message: logged }) => warnings.push(JSON.stringify(logged)))]),
    ]),
  )
  return { exchanges: yield* Ref.get(exchanges), saved: yield* Ref.get(saved), warnings }
})

describe('settled exchange context', () => {
  it.effect('excludes a coalesced response that started before this message but answers it', () =>
    Effect.gen(function* () {
      const result = yield* learn(
        input,
        history(
          [
            message('MARK-before', 'user', 'Help me plan meetings.'),
            message('MARK-before', 'assistant', question),
            message('MARK-host', 'user', 'Can we decide now?'),
            message('MARK-host', 'assistant', 'Morning meetings it is.'),
            message(input.runId, 'user', input.said),
          ],
          [
            completed('MARK-before'),
            completed('MARK-host'),
            {
              ...completed(input.runId),
              answeredBySubmissionId: 'MARK-host',
            },
          ],
        ),
      )
      expect(result.exchanges[0]).toMatchObject({
        previousReply: question,
        recent: [{ speaker: 'Dami', message: 'Help me plan meetings.', reply: question }],
      })
    }),
  )

  it.effect('still learns an isolated fact when Flue history cannot be decoded', () =>
    Effect.gen(function* () {
      const malformed = Effect.succeed(
        HttpClientResponse.fromWeb(
          HttpClientRequest.get('http://runtime.test/history'),
          new Response('{"v":2,"messages":[]}'),
        ),
      )
      const result = yield* learn({ ...input, said: 'I prefer morning meetings.' }, malformed)
      expect(result.saved.map((candidate) => candidate.content)).toEqual([
        'Dami prefers morning meetings.',
      ])
      expect(result.exchanges[0]).toMatchObject({ previousReply: null, recent: [] })
      expect(result.warnings).toHaveLength(1)
    }),
  )

  it.effect(
    'learns a short answer with its question and excludes this reply and future messages',
    () =>
      Effect.gen(function* () {
        const result = yield* learn(
          input,
          history(
            [
              message('MARK-before', 'user', 'Help me plan meetings.'),
              message('MARK-before', 'assistant', question),
              message(input.runId, 'user', input.said),
              message(input.runId, 'assistant', input.replied),
              message('MARK-future', 'user', 'Evening'),
              message('MARK-future', 'assistant', 'Later'),
            ],
            [completed('MARK-before'), completed(input.runId), completed('MARK-future')],
          ),
        )
        expect(result.saved.map((candidate) => candidate.content)).toEqual([
          'Dami prefers morning meetings.',
        ])
        expect(result.exchanges[0]).toMatchObject({
          previousReply: question,
          recent: [{ speaker: 'Dami', message: 'Help me plan meetings.', reply: question }],
        })
        expect(result.warnings).toEqual([])
      }),
  )

  it.effect('logs a failed history read once and still learns the isolated exchange', () =>
    Effect.gen(function* () {
      const result = yield* learn(
        { ...input, said: 'I prefer morning meetings.' },
        Effect.fail(RuntimeUnavailable.make({ message: 'Unavailable' })),
      )
      expect(result.saved.map((candidate) => candidate.content)).toEqual([
        'Dami prefers morning meetings.',
      ])
      expect(result.exchanges[0]).toMatchObject({ previousReply: null, recent: [] })
      expect(result.warnings).toHaveLength(1)
      expect(JSON.stringify(result.warnings)).not.toContain(input.said)
    }),
  )

  it.effect(
    'attributes shared statements by name and omits unattributed messages and control signals',
    () =>
      Effect.gen(function* () {
        const shared = {
          ...input,
          thread: StoredThread.make({
            titleSource: 'Person',
            id: input.thread.id,
            personId: input.thread.personId,
            companyId: input.thread.companyId,
            title: input.thread.title,
            preview: input.thread.preview,
            updatedAt: input.thread.updatedAt,
            archived: input.thread.archived,
            audience: 'company',
            projectId: input.thread.projectId,
          }),
        }
        const ada: FlueConversationMessage = {
          ...message('MARK-ada', 'user', 'I prefer evening meetings.'),
          role: 'system',
          purpose: 'dispatch',
          display: 'diagnostic',
          signal: { tagName: 'message', attributes: { from: 'Ada', person: 'MARK-other-person' } },
        }
        const current = {
          ...ada,
          submissionId: input.runId,
          parts: message(input.runId, 'user', input.said).parts,
          signal: { tagName: 'message', attributes: { from: 'Dami' } },
        }
        const result = yield* learn(
          shared,
          history(
            [
              ada,
              message('MARK-ada', 'assistant', question),
              { ...ada, submissionId: 'MARK-anonymous', signal: { tagName: 'message' } },
              {
                ...ada,
                submissionId: 'MARK-schedule',
                signal: { tagName: 'schedule', attributes: { from: 'Ada' } },
              },
              current,
            ],
            [completed('MARK-ada'), completed(input.runId)],
          ),
        )
        expect(result.exchanges[0]).toMatchObject({
          recent: [{ speaker: 'Ada', message: 'I prefer evening meetings.', reply: question }],
        })
        const exchange = result.exchanges[0]
        if (exchange === undefined) expect.fail('Extraction must run')
        expect(JSON.stringify(exchange.recent)).not.toContain('MARK-')
      }),
  )

  it.effect('bounds prior exchanges to six and the whole context to 8,000 characters', () =>
    Effect.gen(function* () {
      for (const size of [10, 900]) {
        const prior = Array.from({ length: 10 }, (_, index) => `MARK-${index}`)
        const result = yield* learn(
          { ...input, said: 'I prefer morning meetings.' },
          history(
            [
              ...prior.flatMap((id) => [
                message(id, 'user', 'x'.repeat(size)),
                message(id, 'assistant', 'y'.repeat(size)),
              ]),
              message(input.runId, 'user', input.said),
            ],
            prior.map(completed),
          ),
        )
        const exchange = result.exchanges[0]
        if (exchange === undefined) expect.fail('Extraction must run')
        expect(exchange.recent.length).toBeLessThanOrEqual(6)
        if (size === 10) expect(exchange.recent).toHaveLength(6)
        const total =
          (exchange.previousReply === null ? 0 : exchange.previousReply.length) +
          exchange.recent.reduce(
            (count, turn) => count + turn.speaker.length + turn.message.length + turn.reply.length,
            0,
          )
        expect(total).toBeLessThanOrEqual(8000)
      }
    }),
  )
})
