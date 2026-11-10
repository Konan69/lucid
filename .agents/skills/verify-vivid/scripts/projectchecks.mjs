import * as NodeAssert from 'node:assert/strict'
import {
  CheckinArming,
  CheckinFocus,
  CheckinTiming,
  ProjectChange,
  ProjectAuthor,
  ProjectWork,
  RunOrigin,
  WatchPurpose,
} from '@vivid/contracts'
import { observe } from './observation.mjs'
import { chat, history, json, rpc, settled } from './wire.mjs'

/** A real model chooses a Project check, advances it on waking, and its next firing reads completion. */
export async function projectChecks(state, id, directory) {
  const name = 'Launch review'
  const created = await rpc(
    state,
    'CreateProject',
    { name, parentProjectId: null },
    directory,
    'check-project-created',
  )
  await chat(
    state,
    id,
    `My ${name} project is done when I approve a launch checklist. Its next step is to draft three launch checks. Keep it moving while I am away and decide when to revisit it. On your next visit, write your checklist into the Project's progress, leave my approval as its next step, and post the result to my Feed titled ${name}. My time zone is Africa/Lagos.`,
    directory,
  )
  await settled(state, id, 4, 'Completed', directory)
  const list = await rpc(state, 'ListWatches', undefined, directory, 'project-check-chosen')
  const watch = list.watches.find(
    (item) =>
      WatchPurpose.guards.Checkin(item.purpose) &&
      CheckinFocus.guards.Project(item.purpose.focus) &&
      item.purpose.focus.projectId === created.id,
  )
  NodeAssert.ok(watch, 'Vivid did not choose a Project check-in')
  NodeAssert.ok(
    CheckinTiming.guards.Chosen(watch.purpose.timing),
    'The Person did not choose the initial time',
  )
  NodeAssert.ok(
    CheckinArming.guards.Confirmed(watch.purpose.arming),
    'The chosen timer has no receipt',
  )
  await json(directory + '/project-check-chosen-history.json', await history(state, id, directory))

  await chat(
    state,
    id,
    `For this proof, bring ${watch.name} forward to the timer Integration's shortest positive delay. Keep its Project source and checklist instruction. Let the timer fire on its own, then choose the next visit while my approval is pending.`,
    directory,
  )
  await settled(state, id, 5, 'Completed', directory)
  const feed = await observe(state, {
    tag: 'WatchFeed',
    payload: null,
    accept: (value) => value.items.some((item) => item.post !== null && item.post.title === name),
  })
  const item = feed.items.find((entry) => entry.post !== null && entry.post.title === name)
  NodeAssert.ok(item)
  const firing = await settled(state, item.thread, 1, 'Completed', directory)
  const run = firing.runs[0]
  NodeAssert.ok(RunOrigin.guards.Checkin(run.origin))
  NodeAssert.equal(run.origin.watchId, watch.id)
  const projects = await rpc(state, 'ListProjects', undefined, directory, 'project-check-progress')
  const progressed = projects.projects.find((project) => project.id === created.id)
  NodeAssert.ok(progressed && ProjectWork.guards.Active(progressed.work))
  NodeAssert.ok(
    progressed.work.progress.some(
      (line) => ProjectAuthor.guards.Vivid(line.by) && line.by.threadId === item.thread,
    ),
    'The check-in Run did not write Project progress',
  )
  await json(
    directory + '/project-check-firing-history.json',
    await history(state, item.thread, directory),
  )

  // Observe arming before completing, so the next real timer firing reads the completed source.
  const ready = Promise.withResolvers()
  const confirmation = observe(state, {
    tag: 'WatchWatches',
    payload: null,
    accept: (value) => {
      ready.resolve()
      return value.watches.some(
        (entry) =>
          entry.id === watch.id &&
          WatchPurpose.guards.Checkin(entry.purpose) &&
          CheckinArming.guards.Confirmed(entry.purpose.arming) &&
          entry.purpose.arming.nextAt > Date.now() &&
          entry.purpose.arming.operationKey !== watch.purpose.arming.operationKey &&
          CheckinTiming.guards.Requested(entry.purpose.timing) &&
          /five seconds/iu.test(entry.purpose.timing.request),
      )
    },
  })
  await ready.promise
  await chat(
    state,
    id,
    `For this proof, bring ${watch.name} forward to five seconds from now, once, keeping its Project source. Record my exact timing request as five seconds from now. Do not complete the Project or stop its check.`,
    directory,
  )
  const confirmed = await confirmation
  const completed = await rpc(
    state,
    'UpdateProject',
    {
      id: progressed.id,
      expected: progressed.revision,
      change: ProjectChange.cases.Confirm.make({ summary: 'I approve the launch checklist.' }),
    },
    directory,
    'project-check-completed',
  )
  NodeAssert.equal(completed.work._tag, 'Completed')
  await settled(state, id, 6, 'Completed', directory)
  const ended = await observe(state, {
    tag: 'WatchWatches',
    payload: null,
    accept: (value) => !value.watches.some((entry) => entry.id === watch.id),
  })
  await json(directory + '/project-check-proof.json', {
    watch,
    run,
    progressed,
    confirmed,
    completed,
    ended,
  })
}
