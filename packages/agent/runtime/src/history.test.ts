import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import {
  CodeName,
  ConversationState,
  MemoryEntry,
  MemoryFile,
  MemorySearch,
  RuntimeHistoryBody,
  RuntimeHistoryAnswer,
  RuntimeHistoryResult,
  RuntimeSettlement,
  RuntimeHistoryEntry,
  RuntimeHistoryThread,
  ThreadId,
  MemoryScope,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { scenario, ada, admit, delivery, settled } from '../tests/requests.ts'
import { conversationOf, pi } from './threads.ts'

const decodeState = Schema.decodeUnknownEffect(ConversationState)
const decodeAnswer = Schema.decodeUnknownEffect(RuntimeHistoryAnswer)

/** HTTP load is backed by real native SQLite, including receipt settlements and the FTS triggers. */
it.effect('loads two complete histories once, keeps their maps, and indexes memory', () =>
  scenario((_given, runtime) =>
    Effect.gen(function* () {
      const requestId = 'earlier-delivery'
      const user = {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'Look' },
          { type: 'image' as const, data: 'cGljdHVyZQ==', mimeType: 'image/png' },
        ],
        timestamp: 1,
      }
      const tool = fauxAssistantMessage(
        [fauxToolCall('lookup', { query: 'x' }, { id: 'call-1' })],
        { stopReason: 'toolUse' },
      )
      const result = {
        role: 'toolResult' as const,
        toolCallId: 'call-1',
        toolName: 'lookup',
        content: [{ type: 'text' as const, text: 'Found' }],
        isError: false,
        timestamp: 2,
      }
      const answer = fauxAssistantMessage('Here it is')
      const entries = [
        RuntimeHistoryEntry.cases.Delivery.make({
          requestId,
          draft: { kind: 'pi.user', model: [user] },
        }),
        RuntimeHistoryEntry.cases.Run.make({ inputs: [requestId] }),
        RuntimeHistoryEntry.cases.Entry.make({ draft: { kind: 'pi.assistant', model: [tool] } }),
        RuntimeHistoryEntry.cases.Entry.make({
          draft: { kind: 'pi.tool-result', model: [result], data: { diagnostics: [] } },
        }),
        RuntimeHistoryEntry.cases.Entry.make({ draft: { kind: 'pi.assistant', model: [answer] } }),
        RuntimeHistoryEntry.cases.Response.make({
          draft: {
            kind: 'vivid.response',
            data: {
              startedAt: 1,
              finishedAt: 3,
              toolCallCount: 1,
              outcome: 'completed',
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
            },
          },
          inputs: [{ requestId, outcome: 'completed' }],
        }),
      ]
      const threads = ['history-a', 'history-b'].map((id) =>
        RuntimeHistoryThread.make({
          threadId: ThreadId.make(id),
          origin: { creator: ada, creatorName: 'Ada' },
          entries,
        }),
      )
      const entry = MemoryEntry.make({
        layer: 'memory',
        file: MemoryFile.make('copper.md'),
        kind: 'fact',
        description: 'Copper kettle',
        body: 'A copper kettle lives here.',
        basis: 'said',
        scope: MemoryScope.cases.Personal.make({}),
      })
      const body = RuntimeHistoryBody.make({ threads, memory: [{ ...entry, updatedAt: 1234 }] })
      const path = `/persons/${ada}/history`
      const first = yield* runtime.send(path, { method: 'POST', body })
      expect(first.status).toBe(200)
      const map = yield* decodeAnswer(first.body)
      expect(map.threads).toHaveLength(2)
      const before = []
      for (const thread of threads) {
        const page = yield* runtime.persons.use(ada, ({ harness }) =>
          Effect.gen(function* () {
            const conversation = yield* conversationOf(harness, thread.threadId)
            if (Option.isNone(conversation)) return yield* Effect.die('Missing conversation')
            return yield* pi(() =>
              conversation.value.entries(
                { order: 'ascending' },
                100,
                undefined,
                BACKGROUND_CONTEXT,
              ),
            )
          }),
        )
        expect(
          page.items.flatMap((entry) => (entry.model === undefined ? [] : entry.model)),
        ).toEqual([user, tool, result, answer])
        before.push(page.items)
      }
      for (const thread of map.threads) {
        expect(thread._tag).toBe('Loaded')
        if (!RuntimeHistoryResult.guards.Loaded(thread)) return yield* Effect.die('History refused')
        expect(thread.deliveries).toHaveLength(1)
        const receipt = thread.deliveries[0]
        if (receipt === undefined) return yield* Effect.die('Receipt absent')
        expect(receipt.requestId).toBe(requestId)
        const settlement = yield* runtime.send(
          `/persons/${ada}/threads/${thread.threadId}/submissions/${receipt.submissionId}`,
          { method: 'GET' },
        )
        expect(settlement.body).toEqual(
          RuntimeSettlement.cases.Done.make({
            answeredBy: receipt.submissionId,
            reply: 'Here it is',
            toolCalls: 1,
          }),
        )
      }
      expect((yield* runtime.send(path, { method: 'POST', body })).body).toEqual(first.body)
      const search = yield* runtime.memory.search(
        ada,
        MemorySearch.make({ query: 'copper', layer: null, limit: 10, offset: 0 }),
      )
      expect(search.entries.map((hit) => hit.file)).toEqual([entry.file])
      expect(yield* runtime.memory.read(ada, entry)).toMatchObject({
        revision: 1,
        updatedAt: 1234,
        basis: 'said',
      })
      for (const [index, thread] of threads.entries()) {
        const after = yield* runtime.persons.use(ada, ({ harness }) =>
          Effect.gen(function* () {
            const conversation = yield* conversationOf(harness, thread.threadId)
            if (Option.isNone(conversation)) return yield* Effect.die('Missing conversation')
            return yield* pi(() =>
              conversation.value.entries(
                { order: 'ascending' },
                100,
                undefined,
                BACKGROUND_CONTEXT,
              ),
            )
          }),
        )
        expect(after.items).toEqual(before[index])
      }
      yield* admit(runtime, ada, delivery('native-thread', 'native-delivery'))
      const refused = yield* runtime.send(path, {
        method: 'POST',
        body: { threads: [{ ...threads[0], threadId: 'native-thread' }], memory: [] },
      })
      expect(refused.body).toMatchObject({
        threads: [
          RuntimeHistoryResult.cases.Refused.make({
            threadId: ThreadId.make('native-thread'),
            reason: 'ExistingConversation',
          }),
        ],
      })
    }),
  ),
)

const threadId = ThreadId.make('history-outcomes')
const input = (requestId: string) =>
  RuntimeHistoryEntry.cases.Delivery.make({
    requestId,
    draft: { kind: 'pi.user', model: [{ role: 'user', content: requestId, timestamp: 1 }] },
  })
const response = (inputs: typeof RuntimeHistoryEntry.cases.Response.Type.inputs) =>
  RuntimeHistoryEntry.cases.Response.make({
    inputs,
    draft: {
      kind: 'vivid.response',
      data: { outcome: 'completed', startedAt: 1, finishedAt: 2, toolCallCount: 0 },
    },
  })
const outcomes = RuntimeHistoryBody.make({
  memory: [],
  threads: [
    {
      threadId,
      origin: { creator: ada, creatorName: 'Ada' },
      entries: [
        input('first'),
        input('joined'),
        RuntimeHistoryEntry.cases.Run.make({ inputs: ['first', 'joined'] }),
        RuntimeHistoryEntry.cases.Entry.make({
          draft: { kind: 'pi.assistant', model: [fauxAssistantMessage('Both answered')] },
        }),
        response([
          { requestId: 'first', outcome: 'completed' },
          { requestId: 'joined', outcome: 'completed' },
        ]),
        input('failed'),
        RuntimeHistoryEntry.cases.Run.make({ inputs: ['failed'] }),
        RuntimeHistoryEntry.cases.Entry.make({
          draft: {
            kind: 'pi.assistant',
            model: [
              fauxAssistantMessage('', {
                stopReason: 'error',
                errorMessage: '429 Too many requests',
              }),
            ],
          },
        }),
        response([{ requestId: 'failed', outcome: 'failed', failure: 'TimedOut' }]),
        input('stopped'),
        RuntimeHistoryEntry.cases.Run.make({ inputs: ['stopped'] }),
        response([{ requestId: 'stopped', outcome: 'aborted' }]),
        response([]),
        RuntimeHistoryEntry.cases.Entry.make({
          draft: {
            kind: 'pi.user',
            model: [{ role: 'user', content: 'Unsettled words', timestamp: 3 }],
          },
        }),
      ],
    },
  ],
})

/** Imported settlements remain readable, and a later live response joins only its own Run. */
it.effect(
  'loads joined, failed, stopped and unsettled history before answering a new delivery',
  () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        const loaded = yield* decodeAnswer(
          (yield* runtime.send(`/persons/${ada}/history`, { method: 'POST', body: outcomes })).body,
        )
        const [thread] = loaded.threads
        if (thread === undefined || !RuntimeHistoryResult.guards.Loaded(thread))
          return yield* Effect.die('History refused')
        expect(thread.deliveries.map((row) => row.requestId)).toEqual([
          'first',
          'joined',
          'failed',
          'stopped',
        ])
        const [host, joined, failed, stopped] = thread.deliveries
        if (
          host === undefined ||
          joined === undefined ||
          failed === undefined ||
          stopped === undefined
        )
          return yield* Effect.die('Host absent')
        for (const receipt of thread.deliveries) {
          const actual = yield* settled(runtime, ada, threadId, receipt.submissionId)
          if (receipt.requestId === 'failed')
            expect(actual).toEqual(
              RuntimeSettlement.cases.Failed.make({
                failure: 'TimedOut',
                cause: [
                  {
                    service: 'cell',
                    operation: CodeName.make('Response.unanswered'),
                    tag: CodeName.make('TimedOut'),
                  },
                ],
              }),
            )
          else if (receipt.requestId === 'stopped')
            expect(actual).toEqual(RuntimeSettlement.cases.Stopped.make({}))
          else
            expect(actual).toEqual(
              RuntimeSettlement.cases.Done.make({
                answeredBy: host.submissionId,
                reply: 'Both answered',
                toolCalls: 0,
              }),
            )
        }
        given.faux.setResponses([fauxAssistantMessage('A live answer')])
        const live = yield* admit(
          runtime,
          ada,
          delivery(threadId, 'live-delivery', { body: 'New words' }),
        )
        expect(yield* settled(runtime, ada, threadId, live.submissionId)).toEqual(
          RuntimeSettlement.cases.Done.make({
            answeredBy: live.submissionId,
            reply: 'A live answer',
            toolCalls: 0,
          }),
        )
        const page = yield* runtime.send(`/persons/${ada}/threads/${threadId}/state`, {
          method: 'GET',
        })
        const state = yield* decodeState(page.body)
        expect(state.working).toBe(false)
        expect(state.queued).toBe(0)
        expect(state.settlements).toEqual([
          {
            submissionId: String(host.submissionId),
            answeredBy: String(host.submissionId),
            outcome: 'completed',
          },
          {
            submissionId: String(joined.submissionId),
            answeredBy: String(host.submissionId),
            outcome: 'completed',
          },
          { submissionId: String(failed.submissionId), outcome: 'failed' },
          { submissionId: String(stopped.submissionId), outcome: 'aborted' },
          {
            submissionId: String(live.submissionId),
            answeredBy: String(live.submissionId),
            outcome: 'completed',
          },
        ])
        expect(state.messages).toContainEqual(
          expect.objectContaining({
            purpose: 'assistant',
            submissionId: String(live.submissionId),
            parts: [expect.objectContaining({ text: 'A live answer' })],
          }),
        )
        expect(state.messages).toContainEqual(
          expect.objectContaining({
            purpose: 'user',
            parts: [expect.objectContaining({ text: 'Unsettled words' })],
          }),
        )
        return undefined
      }),
    ),
)
