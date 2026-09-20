import { expect, it } from 'vitest'
import { laneConversations } from './lanes'

it('web and native grouping prioritizes pinned work without duplicating conversations', () => {
  const { lanes } = laneConversations([
    { id: 'pinned-working', pinned: true, status: 'working', when: 'today' },
    { id: 'approval', status: 'approve', when: 'today' },
    { id: 'running', status: 'working', when: 'yesterday' },
    { id: 'recent', status: 'ready', when: 'today' },
    { id: 'older', status: 'ready', when: 'earlier' },
  ])

  expect(lanes.map((lane) => [lane.key, lane.items.map((thread) => thread.id)])).toStrictEqual([
    ['pinned', ['pinned-working']],
    ['needs', ['approval']],
    ['working', ['running']],
    ['today', ['recent']],
    ['earlier', ['older']],
  ])
  expect(new Set(lanes.flatMap((lane) => lane.items.map((thread) => thread.id))).size).toBe(5)
})

it('snoozed conversations stay out of date groups and empty sections disappear', () => {
  const { lanes, snoozed } = laneConversations([
    {
      id: 'later',
      status: 'ready',
      when: 'today',
      snoozeUntil: '2099-01-01',
    },
    { id: 'yesterday', status: 'ready', when: 'yesterday' },
  ])

  expect(lanes.map((lane) => lane.key)).toStrictEqual(['yesterday'])
  expect(snoozed.map((thread) => thread.id)).toStrictEqual(['later'])
  expect(laneConversations([])).toStrictEqual({ lanes: [], snoozed: [] })
})
