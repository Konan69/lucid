import { describe, expect, layer } from '@effect/vitest'
import {
  DreamKey,
  DreamPass,
  DreamRequest,
  DreamResponse,
  ProposedAction,
  ReportDreamRequest,
  SignalCue,
  ThreadId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { eq } from 'drizzle-orm'
import { Effect, Exit, Layer, Option, Ref } from 'effect'
import { unbound } from '../approvals/action.ts'
import { Gate, GateDecision } from '../approvals/gate.ts'
import { fixture, trustTestServices } from '../approvals/testing.ts'
import { Database } from '../database/client.ts'
import { testDatabaseConfigured } from '../database/testdb.ts'
import { DeliveryMessage, StoredRunOrigin } from '../threads/conversation.ts'
import { threads } from '../threads/tables.ts'
import { Delivered, person, testLayer } from '../watches/testing.ts'
import { dreamHandlers } from './handlers.ts'
import { dreamThread } from './thread.ts'

/**
 * The Dreamer's server half over the real tables on the disposable database: the cell opens a
 * dream's Background Thread as Vivid acting for the Person, reports its finding from there into
 * the production Conversation (only the runtime behind it stands in), and the Gate lets work in a
 * dream Thread read but never write.
 */

/** Vivid acting for `actor` from `threadId`, as the auth middleware provides it. */
const acting = (actor: Effect.Success<ReturnType<typeof person>>, threadId: ThreadId) =>
  AuthState.Vivid({ person: actor.person, workspace: actor.workspace, threadId })

const key = DreamKey.make('night-2026-11-09')
const finding = ReportDreamRequest.make({
  pass: DreamPass.literals[0],
  finding: 'Your passport renewal appointment is tomorrow at 09:00 and the form is not signed.',
})

const reported = DreamRequest.cases.Report.make(finding)

/** Open the dream's Thread as `home` would, and read the Thread it answers with. */
const opened = Effect.fn('DreamTest.opened')(function* (home: AuthState) {
  const answer = yield* dreamHandlers
    .Dream(DreamRequest.cases.Open.make({ key, pass: 'Night' }))
    .pipe(Effect.provideService(AuthContext, home))
  if (!DreamResponse.guards.Opened(answer)) return yield* Effect.die('Open answers Opened')
  return answer
})

layer(testLayer)((it) => {
  describe.skipIf(!testDatabaseConfigured)('Dreamer Threads and findings', () => {
    it.effect('opens one Background Thread per dream and reports a finding into it', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const home = acting(actor, ThreadId.make(crypto.randomUUID()))
        const first = yield* opened(home)
        const again = yield* opened(home)
        expect(again.threadId, 'asking again opens the same Thread').toBe(first.threadId)
        expect(first.threadId).toBe(dreamThread(actor.person.id, key))
        const database = yield* Database
        const rows = yield* database.run(
          database.select().from(threads).where(eq(threads.id, first.threadId)),
        )
        expect(rows).toMatchObject([
          { place: 'Background', personId: actor.person.id, companyId: null },
        ])

        yield* dreamHandlers
          .Dream(reported)
          .pipe(Effect.provideService(AuthContext, acting(actor, first.threadId)))
        const delivered = (yield* Ref.get(yield* Delivered)).filter(
          (delivery) => delivery.threadId === first.threadId,
        )
        expect(delivered).toMatchObject([
          {
            idempotencyKey: `dream:${first.threadId}`,
            origin: StoredRunOrigin.cases.Dream.make({ pass: 'Night' }),
          },
        ])
        const [delivery] = delivered
        if (delivery === undefined) return
        const message = delivery.message
        expect(DeliveryMessage.guards.Signal(message)).toBe(true)
        if (!DeliveryMessage.guards.Signal(message)) return
        expect(SignalCue.guards.Dream(message.cue)).toBe(true)
        expect(message.cue).toMatchObject({ pass: 'Night' })
        expect('body' in message.cue && message.cue.body).toContain(finding.finding)
      }).pipe(Effect.scoped),
    )

    it.effect('refuses a finding reported from any Thread but a dream', () =>
      Effect.gen(function* () {
        const actor = yield* person()
        const exit = yield* dreamHandlers
          .Dream(reported)
          .pipe(
            Effect.provideService(AuthContext, acting(actor, ThreadId.make(crypto.randomUUID()))),
            Effect.exit,
          )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.stringify(exit)).toContain('Forbidden')
      }).pipe(Effect.scoped),
    )
  })
})

layer(trustTestServices.pipe(Layer.provideMerge(testLayer)))((it) => {
  describe.skipIf(!testDatabaseConfigured)('The Gate in a dream Thread', () => {
    it.effect('lets the Dreamer read and blocks every write before rules or review', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const database = yield* Database
        const dream = dreamThread(test.personal.person.id, key)
        yield* database.run(
          database.insert(threads).values({
            id: dream,
            title: 'Overnight',
            titleSource: 'Assigned',
            personId: test.personal.person.id,
            companyId: null,
            place: 'Background',
            updatedAt: Date.now(),
          }),
        )
        const dreaming = { ...test.vivid, threadId: Option.some(dream) }
        const gate = yield* Gate
        const read = ProposedAction.make({ ...test.connectionAction, effect: 'read' })
        const write = ProposedAction.make({ ...test.connectionAction, effect: 'write' })
        const destructive = ProposedAction.make({ ...test.connectionAction, effect: 'destructive' })
        expect((yield* gate.check(dreaming, read, 'Ordinary', unbound))._tag).toBe('Allowed')
        for (const action of [write, destructive]) {
          const decision = yield* gate.check(dreaming, action, 'Ordinary', unbound)
          expect(GateDecision.guards.Blocked(decision)).toBe(true)
        }
      }).pipe(Effect.scoped),
    )
  })
})
