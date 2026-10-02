import { AuditEvent, MemoryScope, Workspace, type Person, type RunId } from '@vivid/contracts'
import { Cause, Clock, Context, Effect, Layer, Option } from 'effect'
import { Audit } from '../audit/record.ts'
import { summaryOf, type Actor } from '../auth/access.ts'
import { Changes, Topic } from '../live/changes.ts'
import type { StoredThread } from '../threads/access.ts'
import { MemoryExchange, MemoryExtraction, type MemoryCandidate } from './extract.js'
import { MemoryAccess } from './store.js'
import { conversationContext } from './history.ts'
import { Runtime } from '../runtime/client.ts'

export interface LearningInput {
  readonly thread: StoredThread
  readonly person: Person
  readonly said: string
  readonly replied: string
  readonly runId: RunId
}
export interface LearningService {
  readonly afterRun: (input: LearningInput) => Effect.Effect<void>
}

/** A settled Run stays settled even if extraction, storage, or audit is unavailable. */
export class Learning extends Context.Service<Learning, LearningService>()('vivid/Learning') {}

/** Log the failure variant and provider delay only; Messages, memory content, credentials, and driver causes stay private. */
const dropped = <E extends { readonly _tag: string }>(cause: Cause.Cause<E>) => {
  const failure = Cause.findErrorOption(cause)
  if (Option.isNone(failure))
    return Effect.logWarning('Memory learning dropped', {
      tag: Cause.hasInterrupts(cause) ? 'Interrupted' : 'Defect',
    })
  const error = failure.value
  if ('retryAfter' in error)
    return Effect.logWarning('Memory learning dropped', {
      tag: error._tag,
      retryAfter: error.retryAfter,
    })
  return Effect.logWarning('Memory learning dropped', { tag: error._tag })
}

interface LearningDependencies {
  readonly access: MemoryAccess['Service']
  readonly changes: Changes['Service']
  readonly audit: Audit['Service']
}

/** Each candidate has an independent receipt and failure boundary, so one rejected relation does not erase other learned facts. */
const saveCandidate = Effect.fn('Learning.save')(
  function* (dependencies: LearningDependencies, actor: Actor, candidate: MemoryCandidate) {
    const saved = yield* dependencies.access.learn(actor, candidate)
    if (Option.isNone(saved)) return
    const topics = [Topic.person(actor.person.id)]
    if (MemoryScope.guards.Company(saved.value.scope) && Workspace.guards.Company(actor.workspace))
      topics.push(Topic.company(actor.workspace.company.id))
    if (MemoryScope.guards.Thread(saved.value.scope)) {
      topics.push(Topic.thread(saved.value.scope.threadId))
      if (Workspace.guards.Company(actor.workspace))
        topics.push(Topic.company(actor.workspace.company.id))
    }
    yield* dependencies.changes.publish(topics)
    yield* dependencies.audit.record(
      actor,
      AuditEvent.cases.MemorySaved.make({ scope: saved.value.scope._tag }),
    )
  },
  (effect) => effect.pipe(Effect.catchCause(dropped)),
)

/** Learning re-authorizes the settled Thread before recall and shares exactly the handler write policy. */
export const learningLayer = Layer.effect(
  Learning,
  Effect.gen(function* () {
    const access = yield* MemoryAccess
    const extraction = yield* MemoryExtraction
    const changes = yield* Changes
    const audit = yield* Audit
    const runtime = yield* Runtime
    const dependencies = { access, changes, audit }
    return Learning.of({
      afterRun: Effect.fn('Learning.afterRun')(
        function* (input: LearningInput) {
          if (input.said.trim().length === 0) return
          const actor = yield* access.actorFor(input.thread, input.person)
          const context = yield* conversationContext(runtime, input)
          const known = yield* access.recall(actor, {
            query: `${input.said}\n${input.replied}`.slice(0, 400),
            limit: 12,
          })
          const candidates = yield* extraction.extract({
            exchange: MemoryExchange.make({
              person: summaryOf(input.person),
              message: input.said,
              reply: input.replied,
              previousReply: context.previousReply,
              recent: context.recent,
            }),
            known,
            now: yield* Clock.currentTimeMillis,
          })
          yield* Effect.forEach(
            candidates,
            (candidate) => saveCandidate(dependencies, actor, candidate),
            { discard: true },
          )
        },
        (effect) => effect.pipe(Effect.catchCause(dropped)),
      ),
    })
  }),
)

/** An unconfigured installation can settle Runs without acquiring Helix, credentials, or a model client. */
export const silentLearningLayer = Layer.succeed(
  Learning,
  Learning.of({
    afterRun: Effect.fn('Learning.silent')((_input: LearningInput) => Effect.void),
  }),
)
