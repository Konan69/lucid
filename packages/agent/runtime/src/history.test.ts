import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import {
  Note,
  NoteFile,
  NoteSearch,
  RuntimeHistoryBody,
  RuntimeHistoryAnswer,
  RuntimeHistoryResult,
  RuntimeSettlement,
  RuntimeHistoryEntry,
  RuntimeHistoryThread,
  ThreadId,
} from '@vivid/contracts'
import { Effect, Option, Schema } from 'effect'
import { scenario, ada, admit, delivery } from '../tests/requests.ts'
import { conversationOf, pi } from './threads.ts'

const decodeAnswer = Schema.decodeUnknownEffect(RuntimeHistoryAnswer)

/** HTTP load is backed by real native SQLite, including receipt settlements and the FTS triggers. */
it.effect('loads two complete histories once, keeps their maps, and indexes notes', () =>
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
      const note = Note.make({
        layer: 'memory',
        file: NoteFile.make('copper.md'),
        kind: 'fact',
        description: 'Copper kettle',
        body: 'A copper kettle lives here.',
        basis: 'said',
      })
      const body = RuntimeHistoryBody.make({ threads, notes: [note] })
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
      const search = yield* runtime.notes.search(
        ada,
        NoteSearch.make({ query: 'copper', layer: null, limit: 10, offset: 0 }),
      )
      expect(search.entries.map((hit) => hit.file)).toEqual([note.file])
      expect((yield* runtime.notes.read(ada, note)).revision).toBe(1)
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
        body: { threads: [{ ...threads[0], threadId: 'native-thread' }], notes: [] },
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
