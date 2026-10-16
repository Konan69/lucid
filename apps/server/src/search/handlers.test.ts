import { describe, expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import {
  Company,
  CompanyId,
  LibraryFolder,
  LibraryFolderId,
  LibraryItem,
  LibraryItemId,
  Person,
  PersonId,
  PersonSummary,
  SearchResult,
  SessionId,
  Thread,
  ThreadAudience,
  ThreadId,
  Workspace,
} from '@vivid/contracts'
import { AuthContext, AuthState } from '@vivid/contracts/auth'
import type { Actor } from '../auth/access.ts'
import { LibraryStore } from '../library/store.ts'
import { ThreadStore } from '../threads/store.ts'
import { searchHandlers } from './handlers.ts'
import { ConnectionStore } from '../connections/store.ts'

const person = new Person({
  id: PersonId.make('search-person'),
  name: 'Ada',
  email: 'ada@example.test',
})
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

interface VisibleData {
  readonly threads: ReadonlyArray<Thread>
  readonly items: ReadonlyArray<LibraryItem>
  readonly workspace: Workspace
}
const empty: VisibleData = {
  threads: [],
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
    Layer.mock(ConnectionStore, {
      list: Effect.fn('SearchTest.connections')(() => Effect.succeed({ connections: [] })),
    }),
    Layer.mock(ThreadStore, {
      list: Effect.fn('SearchTest.threads')(function* (actor: Actor) {
        expect(actor.person.id).toBe(person.id)
        expect(actor.workspace).toEqual(data.workspace)
        return yield* Effect.succeed(data.threads)
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
  LibraryItem: ({ item: value }): string => value.id,
})

/** Distinct visible records configure stateless stores; each block keeps its own TestClock. */
describe('Search', () => {
  const crossDomain: VisibleData = {
    workspace: Workspace.cases.Company.make({ company, role: 'member' }),
    threads: [
      thread('body', 'Notes', 'annual report', now + 1),
      thread('title', 'Annual report', '', now - 3),
      thread('partial', 'Annual', 'No matching body', now),
    ],
    items: [
      item('mine', 'Annual report', now - 1, 'Mine'),
      item('shared', 'Annual report', now - 2, 'Company'),
    ],
  }

  layer(visibleLayer(crossDomain))((it) => {
    it.effect(
      'searches authorized store results across domains, all terms, title hits before bodies, then newest',
      () =>
        Effect.gen(function* () {
          const { results } = yield* searchHandlers.Search({ query: '  ANNUAL\tReport  ' })
          expect(results.map(resultId)).toEqual(['mine', 'shared', 'title', 'body'])
          const privateText = yield* searchHandlers.Search({ query: 'unsearchable' })
          expect(privateText.results).toEqual([])
        }),
    )
  })
  const matchingThreads = Array.from({ length: 25 }, (_, index) =>
    thread(`thread-${index}`, 'Annual', 'report', index),
  )

  layer(visibleLayer({ ...empty, threads: matchingThreads }))((it) => {
    it.effect('matches terms split across title and body and caps nonempty results at twenty', () =>
      Effect.gen(function* () {
        const { results } = yield* searchHandlers.Search({ query: 'annual report' })
        expect(results).toHaveLength(20)
        expect(results.map(resultId)).toEqual(
          Array.from({ length: 20 }, (_, index) => `thread-${24 - index}`),
        )
      }),
    )
  })
  const recentThreads = Array.from({ length: 12 }, (_, index) =>
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
    Layer.mock(ConnectionStore, {
      list: Effect.fn('SearchTest.connections')(() => Effect.succeed({ connections: [] })),
    }),
    Layer.mock(ThreadStore, { list: () => Effect.succeed(recentThreads) }),
    Layer.mock(LibraryStore, {}),
  )

  layer(onlyThreads)((it) => {
    it.effect('shows eight recent Threads for an empty query without loading other stores', () =>
      Effect.gen(function* () {
        const { results } = yield* searchHandlers.Search({ query: ' \n ' })
        expect(results.map(resultId)).toEqual(
          Array.from({ length: 8 }, (_, index) => `thread-${11 - index}`),
        )
      }),
    )
  })
  const personalItems = [
    item('mine', 'Report', now, 'Mine'),
    item('shared', 'Report', now, 'Company'),
  ]

  layer(visibleLayer({ ...empty, items: personalItems }))((it) => {
    it.effect('does not read Company documents in a personal workspace', () =>
      Effect.gen(function* () {
        const { results } = yield* searchHandlers.Search({ query: 'report' })
        expect(results.map(resultId)).toEqual(['mine'])
      }),
    )
  })
})

describe('Suggestions', () => {
  const recentPersonal: VisibleData = {
    ...empty,
    items: [
      item('new', 'Your notes', now, 'Mine'),
      item('old', 'Old notes', now - 2 * day, 'Mine'),
    ],
  }

  layer(visibleLayer(recentPersonal))((it) => {
    it.effect('offers recent personal documents', () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now)
        const { suggestions } = yield* searchHandlers.ListSuggestions()
        expect(suggestions).toEqual([
          { text: 'Summarise Your notes', reason: 'Added in the last day' },
        ])
      }),
    )
  })
  const recoveredCompany: VisibleData = {
    ...empty,
    workspace: Workspace.cases.Company.make({ company, role: 'member' }),
    items: [item('shared', 'Company notes', now, 'Company')],
  }

  layer(visibleLayer(recoveredCompany))((it) => {
    it.effect('excludes shared documents and offers starters', () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now)
        const { suggestions } = yield* searchHandlers.ListSuggestions()
        expect(suggestions.map((suggestion) => suggestion.text)).toEqual([
          'Connect a service',
          'Remember and correct preferences',
          'Learn how we do this',
        ])
      }),
    )
  })
  const recentItems = Array.from({ length: 6 }, (_, index) =>
    item(`notes-${index}`, `Notes ${index}`, now - index, 'Mine'),
  )

  layer(visibleLayer({ ...empty, items: recentItems }))((it) => {
    it.effect('limits recent personal document suggestions to four, newest first', () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now)
        const { suggestions } = yield* searchHandlers.ListSuggestions()
        expect(suggestions.map((suggestion) => suggestion.text)).toEqual([
          'Summarise Notes 0',
          'Summarise Notes 1',
          'Summarise Notes 2',
          'Summarise Notes 3',
        ])
      }),
    )
  })
})
