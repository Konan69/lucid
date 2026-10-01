import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  Assignee,
  Author,
  Company,
  CompanyId,
  LibraryFolder,
  LibraryFolderId,
  LibraryItem,
  LibraryItemId,
  Occurrence,
  OccurrenceId,
  Person,
  PersonId,
  PersonSummary,
  Routine,
  RoutineId,
  RoutineTrigger,
  SearchResult,
  SessionId,
  Task,
  TaskId,
  Thread,
  ThreadAudience,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import type { Actor } from '../auth/access.ts'
import { LibraryStore } from '../library/store.ts'
import { RoutineStore } from '../routines/store.ts'
import { TaskStore } from '../tasks/store.ts'
import { ThreadStore } from '../threads/store.ts'
import { searchHandlers } from './handlers.ts'

const person = new Person({
  id: PersonId.make('search-person'),
  name: 'Ada',
  email: 'ada@example.test',
})
const owner = PersonSummary.make({ id: person.id, name: person.name, image: null })
const teammate = PersonSummary.make({
  id: PersonId.make('search-teammate'),
  name: 'Bayo',
  image: null,
})
const now = Date.UTC(2026, 9, 1, 12)
const day = 86_400_000
const company = new Company({
  id: CompanyId.make('search-company'),
  name: 'Studio',
  slug: 'studio',
})

/** A shared authorized Thread proves the palette does not impose its own creator-only policy. */
const thread = (id: string, title: string, preview: string, updatedAt: number) =>
  Thread.make({
    id: ThreadId.make(id),
    title,
    preview,
    updatedAt,
    archived: false,
    createdBy: teammate,
    audience: ThreadAudience.cases.Company.make({}),
    projectId: null,
    attention: 'Quiet',
  })

/** Complete wire fixtures keep the test focused on ranking rather than persistence. */
const task = (id: string, title: string, detail: string, dueAt: number | null) =>
  Task.make({
    id: TaskId.make(id),
    title,
    detail,
    dueAt,
    status: 'open',
    priority: 'normal',
    assignee: Assignee.cases.Nobody.make({}),
    origin: { kind: 'manual' },
    createdBy: Author.cases.Person.make({ person: owner }),
    threadId: ThreadId.make('task-thread'),
    overdueNotifiedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    followUps: [],
    nextFollowUpAt: null,
  })

/** Only names are searchable for Library documents; preview text must not introduce a match. */
const item = (id: string, name: string, createdAt: number, shelf: LibraryItem['shelf']) =>
  LibraryItem.make({
    id: LibraryItemId.make(id),
    name,
    createdAt,
    updatedAt: createdAt,
    shelf,
    mimeType: 'text/plain',
    size: 12,
    sha256: 'test-digest',
    status: 'ready',
    error: null,
    preview: 'unsearchable private content',
    chunkCount: 1,
    folderId: null,
  })

/** Occurrences are deliberately supplied out of order to exercise latest-run selection. */
const occurrence = (id: string, status: Occurrence['status'], startedAt: number) =>
  Occurrence.make({
    id: OccurrenceId.make(id),
    routineId: RoutineId.make('review'),
    threadId: ThreadId.make('routine-thread'),
    status,
    startedAt,
    finishedAt: startedAt + 1,
    submissionId: id,
    output: null,
    error: null,
  })

/** Prompt-only matches are searchable, and a Routine's latest failure supplies a next message. */
const routine = (id: string, name: string, prompt: string, runs: ReadonlyArray<Occurrence>) =>
  Routine.make({
    id: RoutineId.make(id),
    name,
    prompt,
    runs,
    trigger: RoutineTrigger.cases.Webhook.make({}),
    enabled: true,
    libraryFolderId: null,
    nextExpectedAt: null,
    lastMissedAt: null,
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
  })

interface VisibleData {
  readonly threads: ReadonlyArray<Thread>
  readonly tasks: ReadonlyArray<Task>
  readonly routines: ReadonlyArray<Routine>
  readonly items: ReadonlyArray<LibraryItem>
  readonly workspace: Workspace
}
const empty: VisibleData = {
  threads: [],
  tasks: [],
  routines: [],
  items: [],
  workspace: Workspace.cases.Personal.make({}),
}

/** These are deliberate store test Layers; the real seam under test is cross-domain orchestration. */
const visibleLayer = (data: VisibleData) =>
  Layer.mergeAll(
    Layer.succeed(
      AuthContext,
      AuthState.Person({
        person,
        workspace: data.workspace,
        sessionId: SessionId.make('search-session'),
      }),
    ),
    Layer.mock(ThreadStore, {
      list: Effect.fn('SearchTest.threads')(function* (actor: Actor) {
        expect(actor.person.id).toBe(person.id)
        expect(actor.workspace).toEqual(data.workspace)
        return yield* Effect.succeed(data.threads)
      }),
    }),
    Layer.mock(TaskStore, {
      list: Effect.fn('SearchTest.tasks')(function* (actor, query) {
        expect(actor.person.id).toBe(person.id)
        expect(query).toEqual({})
        return yield* Effect.succeed([...data.tasks])
      }),
    }),
    Layer.mock(RoutineStore, {
      list: Effect.fn('SearchTest.routines')(function* (actor) {
        expect(actor.person.id).toBe(person.id)
        return yield* Effect.succeed(data.routines)
      }),
    }),
    Layer.mock(LibraryStore, {
      list: Effect.fn('SearchTest.library')(function* (actor, query) {
        expect(actor.person.id).toBe(person.id)
        if (query.shelf === 'Company') expect(Workspace.guards.Company(actor.workspace)).toBe(true)
        return yield* Effect.succeed({
          documents: data.items.filter((document) => document.shelf === query.shelf),
          folders: [
            LibraryFolder.make({
              id: LibraryFolderId.make('folder'),
              name: 'Annual report',
              parentId: null,
              createdAt: now,
              updatedAt: now,
              itemCount: 0,
              shelf: query.shelf,
            }),
          ],
        })
      }),
    }),
  )

/** Exhaustive result projection makes mixed-domain ordering assertions readable. */
const resultId = SearchResult.match({
  Thread: ({ thread: value }): string => value.id,
  Task: ({ task: value }): string => value.id,
  Routine: ({ routine: value }): string => value.id,
  LibraryItem: ({ item: value }): string => value.id,
})

describe('Search', () => {
  it.effect(
    'searches authorized store results across domains, all terms, title hits before bodies, then newest',
    () =>
      Effect.gen(function* () {
        const data: VisibleData = {
          workspace: Workspace.cases.Company.make({ company, role: 'member' }),
          threads: [
            thread('body', 'Notes', 'annual report', now + 1),
            thread('title', 'Annual report', '', now - 3),
            thread('partial', 'Annual', 'No matching body', now),
          ],
          tasks: [task('task', 'Annual report', 'Budget', null)],
          routines: [routine('routine', 'Review', 'Annual report', [])],
          items: [
            item('mine', 'Annual report', now - 1, 'Mine'),
            item('shared', 'Annual report', now - 2, 'Company'),
          ],
        }
        const { results } = yield* searchHandlers
          .Search({ query: '  ANNUAL\tReport  ' })
          .pipe(Effect.provide(visibleLayer(data)))
        expect(results.map(resultId)).toEqual([
          'task',
          'mine',
          'shared',
          'title',
          'body',
          'routine',
        ])
        const privateText = yield* searchHandlers
          .Search({ query: 'unsearchable' })
          .pipe(Effect.provide(visibleLayer(data)))
        expect(privateText.results).toEqual([])
      }),
  )

  it.effect('matches terms split across title and body and caps nonempty results at twenty', () =>
    Effect.gen(function* () {
      const threads = Array.from({ length: 25 }, (_, index) =>
        thread(`thread-${index}`, 'Annual', 'report', index),
      )
      const { results } = yield* searchHandlers
        .Search({ query: 'annual report' })
        .pipe(Effect.provide(visibleLayer({ ...empty, threads })))
      expect(results).toHaveLength(20)
      expect(results.map(resultId)).toEqual(
        Array.from({ length: 20 }, (_, index) => `thread-${24 - index}`),
      )
    }),
  )

  it.effect('shows eight recent Threads for an empty query without loading other stores', () =>
    Effect.gen(function* () {
      const threads = Array.from({ length: 12 }, (_, index) =>
        thread(`thread-${index}`, 'Recent', '', index),
      )
      const onlyThreads = Layer.mergeAll(
        Layer.succeed(
          AuthContext,
          AuthState.Person({
            person,
            workspace: empty.workspace,
            sessionId: SessionId.make('search-session'),
          }),
        ),
        Layer.mock(ThreadStore, { list: () => Effect.succeed(threads) }),
        Layer.mock(TaskStore, {}),
        Layer.mock(RoutineStore, {}),
        Layer.mock(LibraryStore, {}),
      )
      const { results } = yield* searchHandlers
        .Search({ query: ' \n ' })
        .pipe(Effect.provide(onlyThreads))
      expect(results.map(resultId)).toEqual(
        Array.from({ length: 8 }, (_, index) => `thread-${11 - index}`),
      )
    }),
  )

  it.effect('does not read Company documents in a personal workspace', () =>
    Effect.gen(function* () {
      const items = [item('mine', 'Report', now, 'Mine'), item('shared', 'Report', now, 'Company')]
      const { results } = yield* searchHandlers
        .Search({ query: 'report' })
        .pipe(Effect.provide(visibleLayer({ ...empty, items })))
      expect(results.map(resultId)).toEqual(['mine'])
    }),
  )
})

describe('Suggestions', () => {
  it.effect(
    'prefers overdue Tasks, then upcoming work, new personal documents and failed Routines',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now)
        const data: VisibleData = {
          ...empty,
          tasks: [
            task('due', 'Prepare slides', '', now + day),
            task('late', 'Review proposal', '', now - day),
          ],
          items: [
            item('new', 'Your notes', now, 'Mine'),
            item('old', 'Old notes', now - 2 * day, 'Mine'),
          ],
          routines: [
            routine('review', 'Morning brief', '', [
              occurrence('latest', 'failed', now),
              occurrence('older', 'succeeded', now - day),
            ]),
          ],
        }
        const { suggestions } = yield* searchHandlers
          .ListSuggestions()
          .pipe(Effect.provide(visibleLayer(data)))
        expect(suggestions.map((suggestion) => suggestion.text)).toEqual([
          'Chase Review proposal',
          'Work on Prepare slides',
          'Summarise Your notes',
          'Look at why Morning brief failed',
        ])
        expect(suggestions[0]).toEqual({
          text: 'Chase Review proposal',
          reason: 'Overdue since 2026-09-30',
        })
      }),
  )

  it.effect(
    'excludes completed, distant and other people’s Tasks, shared documents and recovered Routines',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now)
        const otherTask = Task.make({
          ...task('others', 'Other work', '', now - day),
          createdBy: Author.cases.Person.make({ person: teammate }),
        })
        const data: VisibleData = {
          ...empty,
          workspace: Workspace.cases.Company.make({ company, role: 'member' }),
          tasks: [
            otherTask,
            Task.make({ ...task('done', 'Finished work', '', now - day), status: 'done' }),
            task('later', 'Later work', '', now + 3 * day),
          ],
          items: [item('shared', 'Company notes', now, 'Company')],
          routines: [
            routine('review', 'Recovered', '', [
              occurrence('old', 'failed', now - day),
              occurrence('new', 'succeeded', now),
            ]),
          ],
        }
        const { suggestions } = yield* searchHandlers
          .ListSuggestions()
          .pipe(Effect.provide(visibleLayer(data)))
        expect(suggestions.map((suggestion) => suggestion.text)).toEqual([
          'Plan my week',
          'Draft a reply to an email I paste in',
          'Remind me of something tomorrow at 9',
          'Set up a morning brief',
        ])
      }),
  )

  it.effect(
    'includes work assigned to this Person even when another Person created it, with a four-message limit',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now)
        const tasks = Array.from({ length: 6 }, (_, index) =>
          Task.make({
            ...task(`assigned-${index}`, `Assigned ${index}`, '', now - (index + 1) * day),
            createdBy: Author.cases.Vivid.make({ onBehalfOf: teammate }),
            assignee: Assignee.cases.Member.make({ person: owner }),
          }),
        )
        const { suggestions } = yield* searchHandlers
          .ListSuggestions()
          .pipe(Effect.provide(visibleLayer({ ...empty, tasks })))
        expect(suggestions.map((suggestion) => suggestion.text)).toEqual([
          'Chase Assigned 5',
          'Chase Assigned 4',
          'Chase Assigned 3',
          'Chase Assigned 2',
        ])
      }),
  )
})
