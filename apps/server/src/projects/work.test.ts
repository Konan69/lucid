import { describe, expect, layer } from '@effect/vitest'
import {
  ConversationState,
  MessageId,
  ProjectAuthor,
  ProjectChange,
  ProjectChanged,
  ProjectEvidence,
  ProjectEvidenceMissing,
  ProjectNotActive,
  ProjectRevision,
  ProjectToolCallId,
  ProjectWork,
  SessionId,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import { Effect, Layer, Schema, Stream } from 'effect'
import { HttpClientRequest, HttpClientResponse } from 'effect/http'
import { fixture } from '../approvals/testing.ts'
import { testDatabaseConfigured, testDatabaseLayer } from '../database/testdb.ts'
import { changesLayer } from '../live/changes.ts'
import { Runtime } from '../runtime/client.ts'
import { projectHandlers } from './handlers.ts'
import { ProjectStore, projectStoreLayer } from './store.ts'

const encodeState = Schema.encodeEffect(ConversationState)

/**
 * The runtime's answer for the Thread: the Person saying the domain resolves, then Vivid's reply
 * holding the `update_project` call `call-done`. Only the conversation transport is answered here;
 * the Project store, Thread access and evidence resolution are the real ones.
 */
const conversation = ConversationState.make({
  messages: [
    {
      id: 'entry-3',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      parts: [{ type: 'text', text: 'The domain resolves now.', state: 'done' }],
    },
    {
      id: 'run-4',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'update_project',
          toolCallId: 'call-done',
          input: {},
          state: 'input-available',
        },
      ],
    },
  ],
  settlements: [],
  working: true,
  queued: 0,
})

const runtimeLayer = Layer.effect(
  Runtime,
  Effect.gen(function* () {
    const body = JSON.stringify(yield* encodeState(conversation))
    return Runtime.of({
      admit: () => Effect.die('not admitted in this test'),
      settled: () => Effect.never,
      stop: () => Effect.succeed(false),
      child: () => Effect.die('Project tests start no helpers'),
      stopChild: () => Effect.succeed(false),
      watch: () => Stream.never,
      read: () =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            HttpClientRequest.get('http://runtime.test'),
            new Response(body, { headers: { 'content-type': 'application/json' } }),
          ),
        ),
    })
  }),
)

const testLayer = Layer.mergeAll(projectStoreLayer, changesLayer, runtimeLayer).pipe(
  Layer.provideMerge(testDatabaseLayer),
)

const define = ProjectChange.cases.Define.make({
  objective: 'Launch the site: done when the domain resolves',
  nextStep: 'Point the domain at the host',
})

describe.skipIf(!testDatabaseConfigured)('Project work', () => {
  layer(testLayer)((it) => {
    it.effect('a stale revision is refused with the revision there is', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ProjectStore
        const created = yield* store.create(test.personal, { name: 'Site', parentProjectId: null })
        expect(created.work).toEqual(ProjectWork.cases.Unspecified.make({}))
        expect(created.revision).toBe(0)

        const early = yield* Effect.flip(
          projectHandlers
            .UpdateProject({
              id: created.id,
              expected: ProjectRevision.make(0),
              change: ProjectChange.cases.Progress.make({ text: 'Bought it', nextStep: 'DNS' }),
            })
            .pipe(Effect.provideService(AuthContext, vividIn(test))),
        )
        expect(early).toEqual(new ProjectNotActive({ id: created.id }))

        const defined = yield* projectHandlers
          .UpdateProject({ id: created.id, expected: ProjectRevision.make(0), change: define })
          .pipe(Effect.provideService(AuthContext, vividIn(test)))
        expect(defined.revision).toBe(1)
        expect(ProjectWork.guards.Active(defined.work)).toBe(true)

        const stale = yield* Effect.flip(
          projectHandlers
            .UpdateProject({ id: created.id, expected: ProjectRevision.make(0), change: define })
            .pipe(Effect.provideService(AuthContext, vividIn(test))),
        )
        expect(stale).toEqual(
          new ProjectChanged({
            id: created.id,
            expected: ProjectRevision.make(0),
            actual: ProjectRevision.make(1),
          }),
        )
        expect(yield* store.list(test.personal)).toMatchObject([{ revision: 1 }])
      }).pipe(Effect.scoped),
    )

    it.effect('completion cites a message of the Run, and is refused without one', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ProjectStore
        const created = yield* store.create(test.personal, { name: 'Site', parentProjectId: null })
        const asVivid = Effect.provideService(AuthContext, vividIn(test))
        yield* projectHandlers
          .UpdateProject({ id: created.id, expected: ProjectRevision.make(0), change: define })
          .pipe(asVivid)
        const progressed = yield* projectHandlers
          .UpdateProject({
            id: created.id,
            expected: ProjectRevision.make(1),
            change: ProjectChange.cases.Progress.make({
              text: 'Domain bought',
              nextStep: 'Wait for DNS',
            }),
          })
          .pipe(asVivid)
        expect(ProjectWork.guards.Active(progressed.work) && progressed.work.progress).toEqual([
          {
            at: expect.any(Number),
            text: 'Domain bought',
            by: ProjectAuthor.cases.Vivid.make({
              personId: test.personal.person.id,
              threadId: test.personalId,
            }),
          },
        ])

        const complete = (toolCallId: string) =>
          ProjectChange.cases.Complete.make({
            summary: 'The Person said the domain resolves',
            toolCallId: ProjectToolCallId.make(toolCallId),
            said: 'person',
          })
        const unread = yield* Effect.flip(
          projectHandlers
            .UpdateProject({
              id: created.id,
              expected: ProjectRevision.make(2),
              change: complete('call-elsewhere'),
            })
            .pipe(asVivid),
        )
        expect(unread).toEqual(new ProjectEvidenceMissing({ id: created.id }))
        const fromPerson = yield* Effect.flip(
          projectHandlers
            .UpdateProject({
              id: created.id,
              expected: ProjectRevision.make(2),
              change: complete('call-done'),
            })
            .pipe(Effect.provideService(AuthContext, personIn(test))),
        )
        expect(fromPerson).toEqual(new ProjectEvidenceMissing({ id: created.id }))
        expect(yield* store.list(test.personal)).toMatchObject([{ revision: 2 }])

        const done = yield* projectHandlers
          .UpdateProject({
            id: created.id,
            expected: ProjectRevision.make(2),
            change: complete('call-done'),
          })
          .pipe(asVivid)
        expect(ProjectWork.guards.Completed(done.work) && done.work.proof.sources).toEqual([
          ProjectEvidence.cases.ThreadMessage.make({
            threadId: test.personalId,
            messageId: MessageId.make('entry-3'),
          }),
        ])
      }).pipe(Effect.scoped),
    )

    it.effect('the Person sets the goal and marks it done in their own words', () =>
      Effect.gen(function* () {
        const test = yield* fixture()
        const store = yield* ProjectStore
        const created = yield* store.create(test.personal, { name: 'Site', parentProjectId: null })
        const asPerson = Effect.provideService(AuthContext, personIn(test))
        const confirm = ProjectChange.cases.Confirm.make({
          summary: 'The site loads at the domain',
        })

        const early = yield* Effect.flip(
          projectHandlers
            .UpdateProject({ id: created.id, expected: ProjectRevision.make(0), change: confirm })
            .pipe(asPerson),
        )
        expect(early).toEqual(new ProjectNotActive({ id: created.id }))

        yield* projectHandlers
          .UpdateProject({ id: created.id, expected: ProjectRevision.make(0), change: define })
          .pipe(asPerson)
        const fromRun = yield* Effect.flip(
          projectHandlers
            .UpdateProject({ id: created.id, expected: ProjectRevision.make(1), change: confirm })
            .pipe(Effect.provideService(AuthContext, vividIn(test))),
        )
        expect(fromRun).toEqual(new ProjectEvidenceMissing({ id: created.id }))

        const done = yield* projectHandlers
          .UpdateProject({ id: created.id, expected: ProjectRevision.make(1), change: confirm })
          .pipe(asPerson)
        expect(ProjectWork.guards.Completed(done.work) && done.work.objective).toBe(
          define.objective,
        )
        expect(ProjectWork.guards.Completed(done.work) && done.work.proof).toEqual({
          summary: 'The site loads at the domain',
          sources: [ProjectEvidence.cases.Person.make({ personId: test.personal.person.id })],
        })
        expect(yield* store.list(test.personal)).toMatchObject([{ revision: 2 }])
      }).pipe(Effect.scoped),
    )
  })
})

/** The fixture's Person on their own page, with no Run. */
const personIn = (test: Effect.Success<ReturnType<typeof fixture>>) =>
  AuthState.Person({
    person: test.personal.person,
    workspace: test.personal.workspace,
    sessionId: SessionId.make('project-work-session'),
  })

/** Vivid inside the fixture's personal Thread, acting for its Person. */
const vividIn = (test: Effect.Success<ReturnType<typeof fixture>>) =>
  AuthState.Vivid({
    person: test.personal.person,
    workspace: test.personal.workspace,
    threadId: test.personalId,
  })
