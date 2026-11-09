import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { ConversationId, Harness } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import {
  ChildRun,
  ChildRunState,
  ChildTurn,
  DEFAULT_CHILD_BUDGET,
  RunId,
  RuntimeChildMessaged,
  ThreadId,
} from '@vivid/contracts'
import { Deferred, Effect, Option, Schema } from 'effect'
import { ada, admit, delivery, scenario, settled, threadPath } from '../tests/requests.ts'
import { HelperIndex, HelperRounds } from './children.ts'
import { conversationOf, pi } from './threads.ts'

const THREAD = ThreadId.make('helper-follow-up')
const decodeMessaged = Schema.decodeUnknownEffect(RuntimeChildMessaged)

/**
 * Looks, and when the answer is not there yet waits for the next commit and looks again: a
 * signal, never a timer.
 */
const until = Effect.fn('HelperProof.until')(function* <A>(
  harness: Harness,
  look: Effect.Effect<Option.Option<A>, unknown>,
) {
  for (;;) {
    const committed = yield* Deferred.make<void>()
    const stop = harness.subscribeCommits(() => {
      Deferred.doneUnsafe(committed, Effect.void)
    })
    // Subscribed until the next commit arrives, so one made while looking is not missed.
    const found = yield* look.pipe(
      Effect.tap((seen) => (Option.isSome(seen) ? Effect.void : Deferred.await(committed))),
      Effect.ensuring(Effect.sync(stop)),
    )
    if (Option.isSome(found)) return found.value
  }
})

/** What a conversation's model saw, in order: who said it and the words. */
const transcript = Effect.fn('HelperProof.transcript')(function* (
  harness: Harness,
  id: ConversationId,
) {
  const conversation = yield* pi(() => harness.conversation(id, BACKGROUND_CONTEXT))
  if (conversation === undefined) return []
  const page = yield* pi(() =>
    conversation.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT),
  )
  return page.items.flatMap((entry) =>
    (entry.model === undefined ? [] : entry.model).flatMap((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return []
      const parts = typeof message.content === 'string' ? [message.content] : message.content
      const words = parts
        .flatMap((part) =>
          typeof part === 'string' ? [part] : part.type === 'text' ? [part.text] : [],
        )
        .join('')
      return [`${message.role}: ${words}`]
    }),
  )
})

describe('a helper taking a follow-up, on native Pi SQLite', () => {
  it.effect('reaches its own conversation as its next turn, and it answers again', () =>
    scenario((given, runtime) =>
      Effect.gen(function* () {
        given.faux.setResponses([
          fauxAssistantMessage('Okay.'),
          fauxAssistantMessage('First answer.'),
          fauxAssistantMessage('Second answer.'),
        ])
        const receipt = yield* admit(runtime, ada, delivery(THREAD, 'message-1'))
        yield* settled(runtime, ada, THREAD, receipt.submissionId)
        const runId = RunId.make('helper_follow_up_proof')
        const brief = 'Find the opening hours of the library.'
        // The helper as the server reserves it, started the way `spawn_run` starts it.
        const child = yield* runtime.persons.use(ada, (person) =>
          Effect.gen(function* () {
            const conversation = yield* conversationOf(person.harness, THREAD)
            if (Option.isNone(conversation)) return yield* Effect.die('No Thread conversation')
            const thread = conversation.value.id
            const run = ChildRun.make({
              id: runId,
              parentRunId: RunId.make('run_follow_up_proof'),
              parentToolCallId: 'call-1',
              threadId: THREAD,
              number: 1,
              kind: 'Researcher',
              brief,
              budget: DEFAULT_CHILD_BUDGET,
              requestedAt: 0,
              state: ChildRunState.cases.Reserved.make({}),
              turn: ChildTurn.cases.Brief.make({}),
            })
            yield* pi(() =>
              person.harness.commit(
                (tx) =>
                  person.helpers.start(tx, thread, run, {
                    acting: { threadId: THREAD, personId: ada },
                    timezone: 'UTC',
                    at: 0,
                  }),
                BACKGROUND_CONTEXT,
              ),
            )

            const id = yield* until(
              person.harness,
              pi(() => person.harness.snapshot(HelperIndex, thread, BACKGROUND_CONTEXT)).pipe(
                Effect.map((index) => {
                  const kept = index === undefined ? undefined : index.helpers[runId]
                  return Option.fromNullOr(kept === undefined ? null : kept.child)
                }),
              ),
            )
            yield* until(
              person.harness,
              transcript(person.harness, id).pipe(
                Effect.map((said) =>
                  said.includes('assistant: First answer.') ? Option.some(said) : Option.none(),
                ),
              ),
            )
            return { id, thread }
          }),
        )

        // A Person's follow-up through the route the server calls; the same round again is a repeat.
        const message = {
          round: 2,
          message: 'Now the weekend hours too.',
          by: 'Person',
          budget: DEFAULT_CHILD_BUDGET,
        }
        const path = `${threadPath(ada, THREAD)}/children/${runId}/messages`
        for (const _ of [1, 2]) {
          const answer = yield* runtime.send(path, { method: 'POST', body: message })
          expect(answer.status).toBe(200)
          expect(yield* decodeMessaged(answer.body)).toEqual(
            RuntimeChildMessaged.cases.Started.make({}),
          )
        }

        const said = yield* runtime.persons.use(ada, (person) =>
          Effect.gen(function* () {
            const rounds = yield* pi(() =>
              person.harness.snapshot(HelperRounds, child.thread, BACKGROUND_CONTEXT),
            )
            expect(rounds === undefined ? [] : Object.keys(rounds.rounds)).toEqual([runId])
            expect(rounds === undefined ? undefined : rounds.rounds[runId]?.round).toBe(2)
            return yield* until(
              person.harness,
              transcript(person.harness, child.id).pipe(
                Effect.map((all) =>
                  all.includes('assistant: Second answer.') ? Option.some(all) : Option.none(),
                ),
              ),
            )
          }),
        )
        // Its own conversation, in order: the brief, its answer, the follow-up, its next answer.
        expect(said).toEqual([
          `user: ${brief}`,
          'assistant: First answer.',
          'user: The person you are working for sends this follow-up:\n\nNow the weekend hours too.',
          'assistant: Second answer.',
        ])
      }),
    ),
  )
})
