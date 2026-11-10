import * as assert from 'node:assert/strict'
import { CreateProjectRequest, Tool } from '@vivid/contracts'
import { chat, history, json, rpc, settled } from './wire.mjs'
import { projectChecks } from './projectchecks.mjs'

/** The Project the journey makes for the Person before talking about it. */
export const PROJECT_NAME = 'Site launch ' + crypto.randomUUID().slice(0, 8)

/**
 * What a Person says about a Project's goal, then how it moved, then that it is done. No tool,
 * field or state is named (the owner, 26 October 2026: ask as a Person asks).
 */
export const DEFINE_PROMPT = `We're launching the site, that's my ${PROJECT_NAME} project. It's done when the domain resolves.`
export const PROGRESS_PROMPT = `Update on ${PROJECT_NAME}: I bought the domain this morning and pointed it at the host.`
export const DONE_PROMPT = `Good news on ${PROJECT_NAME}: the domain resolves now.`

/** Make the Project through the public call the Projects page's form makes. */
export async function createProject(state, directory) {
  return rpc(
    state,
    'CreateProject',
    CreateProjectRequest.make({ name: PROJECT_NAME, parentProjectId: null }),
    directory,
    'created',
  )
}

/** The Project as the list the page draws reads it, by its id. */
export async function projectNow(state, created, directory, name) {
  const listed = await rpc(state, 'ListProjects', undefined, directory, name)
  const project = listed.projects.find((item) => item.id === created.id)
  assert.ok(project, 'The created Project is not listed')
  return project
}

/** The Run's successful `update_project` calls: the sentence changed the Project, not only the reply. */
export async function updateCalls(state, id, run, directory, name) {
  const page = await history(state, id, directory)
  const calls = page.messages
    .filter((message) => message.role === 'assistant' && message.submissionId === run)
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool' && part.toolName === Tool.update_project)
  await json(directory + '/' + name + '-calls.json', calls)
  assert.ok(
    calls.some((call) => call.state === 'output-available'),
    'Expected an update_project call that succeeded, found ' + calls.length,
  )
  return calls
}

/** One message to Vivid and the Run it starts, settled. */
export async function say(state, id, prompt, runs, directory) {
  await chat(state, id, prompt, directory)
  const detail = await settled(state, id, runs, 'Completed', directory)
  return detail.runs[runs - 1].submissionId
}

/** Active with an objective about the domain and a next step, as the page's Goal and Next lines. */
export function assertDefined(project) {
  assert.equal(project.work._tag, 'Active', 'The Project has no objective after the goal was said')
  assert.match(project.work.objective, /domain/iu, 'The objective does not say what done means')
  assert.ok(project.work.nextStep.trim().length > 0, 'The Project has no next step')
}

/** A dated progress line about what the Person said moved, the page's Latest line. */
export function assertProgressed(project, before) {
  assert.equal(project.work._tag, 'Active', 'The Project is not active after progress')
  const latest = project.work.progress.at(-1)
  assert.ok(latest, 'No progress line was recorded')
  assert.match(latest.text, /domain|host/iu, 'The progress line does not say what moved')
  assert.ok(latest.at >= before, 'The progress line is not dated by this message')
  assert.equal(latest.by._tag, 'Vivid', 'The progress line is not attributed to Vivid')
}

/**
 * The Project's work through the server's public surfaces. The Person makes a Project, says what
 * done means, says how it moved, then says it is done; after each message the list the Project
 * page reads (`ListProjects`, the projection `WatchProjects` publishes) shows the objective, the
 * dated progress and next step, then Completed with a proof that cites a message of this Thread.
 */
export async function projects(state, id, directory) {
  assert.equal(
    state.modelKind,
    'real',
    'Project state needs a real model; rehearsal cannot prove it',
  )
  const created = await createProject(state, directory)
  assert.equal(created.work._tag, 'Unspecified', 'A new Project should have no objective')

  const definedRun = await say(state, id, DEFINE_PROMPT, 1, directory)
  await updateCalls(state, id, definedRun, directory, 'define')
  const defined = await projectNow(state, created, directory, 'defined')
  assertDefined(defined)

  const before = Date.now()
  const progressRun = await say(state, id, PROGRESS_PROMPT, 2, directory)
  await updateCalls(state, id, progressRun, directory, 'progress')
  const progressed = await projectNow(state, created, directory, 'progressed')
  assertProgressed(progressed, before)
  assert.equal(progressed.work.objective, defined.work.objective, 'Progress replaced the objective')

  const doneRun = await say(state, id, DONE_PROMPT, 3, directory)
  await updateCalls(state, id, doneRun, directory, 'done')
  const done = await projectNow(state, created, directory, 'done')
  assert.equal(done.work._tag, 'Completed', 'The Project is not done after the Person said so')
  const [source] = done.work.proof.sources
  assert.equal(source.threadId, id, 'The proof does not cite this Thread')
  const page = await history(state, id, directory)
  assert.ok(
    page.messages.some((message) => message.id === source.messageId),
    'The proof cites a message this Thread does not hold',
  )
  await projectChecks(state, id, directory)
  await json(directory + '/scope.json', {
    proved:
      'Real model records a Project objective, a dated progress line and completion from three Person messages; the list the page reads carries them; the proof cites a message of the Thread.',
    unsupported: [
      'Company Projects and a Member who cannot open the proof Thread',
      'native phone and desktop pages',
    ],
  })
}
