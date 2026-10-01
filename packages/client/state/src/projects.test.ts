import {
  PersonId,
  Project,
  ProjectId,
  ProjectListResponse,
  ThreadAudience,
  ThreadId,
  type Thread,
} from '@vivid/contracts'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import * as projects from './projects.js'

const NOW = Date.UTC(2026, 9, 1, 12)
const ada = PersonId.make('ada')

const project = (
  id: string,
  parent: string | null,
  changes: { readonly name?: string; readonly threadCount?: number },
) =>
  new Project({
    id: ProjectId.make(id),
    companyId: null,
    name: changes.name === undefined ? id : changes.name,
    parentProjectId: parent === null ? null : ProjectId.make(parent),
    createdBy: ada,
    threadCount: changes.threadCount === undefined ? 0 : changes.threadCount,
    updatedAt: NOW,
  })

const thread = (id: string, projectId: string | null, changes: Partial<Thread>): Thread => ({
  id: ThreadId.make(id),
  title: id,
  preview: '',
  updatedAt: NOW,
  archived: false,
  createdBy: { id: ada, name: 'Ada', image: null },
  audience: ThreadAudience.cases.Private.make({}),
  projectId: projectId === null ? null : ProjectId.make(projectId),
  attention: 'Quiet',
  ...changes,
})

describe('arranging Projects', () => {
  const move = project('move', null, { name: 'office move' })
  const audit = project('audit', null, { name: 'Audit' })
  const floor = project('floor', 'move', {})
  const desks = project('desks', 'floor', {})
  const all = [move, audit, floor, desks]

  it('puts only top-level Projects on the shelf, by name whatever its case', () => {
    expect(projects.projectsIn(all, null).map((each) => each.id)).toEqual(['audit', 'move'])
    expect(projects.projectsIn(all, move.id).map((each) => each.id)).toEqual(['floor'])
  })

  it('walks the Projects above one, outermost first', () => {
    expect(projects.trailTo(all, desks).map((each) => each.id)).toEqual(['move', 'floor'])
    expect(projects.trailTo(all, move)).toEqual([])
  })

  it('ends the trail at a parent the Person cannot see, and at a loop', () => {
    const orphan = project('orphan', 'gone', {})
    expect(projects.trailTo([orphan], orphan)).toEqual([])
    const first = project('first', 'second', {})
    const second = project('second', 'first', {})
    expect(projects.trailTo([first, second], first).map((each) => each.id)).toEqual(['second'])
  })

  it('finds no Project once it is no longer in the list', () => {
    expect(Option.isNone(projects.findProject(all, ProjectId.make('gone')))).toBe(true)
  })
})

describe("a Project's Threads", () => {
  const list = {
    threads: [
      thread('old', 'move', { updatedAt: NOW - 10 }),
      thread('new', 'move', { updatedAt: NOW }),
      thread('archived', 'move', { archived: true }),
      thread('elsewhere', 'audit', {}),
      thread('unfiled', null, {}),
    ],
  }

  it('lists the open Threads filed in the Project, most recently moved first', () => {
    expect(projects.threadsIn(list, ProjectId.make('move')).map((each) => each.id)).toEqual([
      'new',
      'old',
    ])
  })

  it('counts the Threads filed there that the Person is not in, never below zero', () => {
    const filed = projects.threadsIn(list, ProjectId.make('move'))
    expect(projects.hiddenThreads(project('move', null, { threadCount: 5 }), filed)).toBe(3)
    expect(projects.hiddenThreads(project('move', null, { threadCount: 1 }), filed)).toBe(0)
  })

  it('counts in words', () => {
    expect([projects.countThreads(0), projects.countThreads(1), projects.countThreads(2)]).toEqual([
      '0 Threads',
      '1 Thread',
      '2 Threads',
    ])
  })
})

describe('confirmed', () => {
  it('adds a Project the server just returned once, however the two answers are ordered', () => {
    const list = new ProjectListResponse({ projects: [project('a', null, {})] })
    const created = project('b', null, {})
    const once = projects.confirmed(created)(list)
    expect(once.projects.map((each) => each.id)).toEqual(['b', 'a'])
    expect(projects.confirmed(created)(once)).toBe(once)
  })
})
