import * as assert from 'node:assert/strict'
import {
  DEFINE_PROMPT,
  PROGRESS_PROMPT,
  assertDefined,
  assertProgressed,
  createProject,
  projectNow,
  updateCalls,
} from './projects.mjs'
import { json, settled } from './wire.mjs'

/** The page's "Where it stands" lines, read from the rendered page as term → text. */
const standing = `(() => {
  const part = Array.from(document.querySelectorAll('section')).find((section) => section.querySelector('h2')?.innerText === 'Where it stands')
  if (!part) return null
  return Object.fromEntries(Array.from(part.querySelectorAll('dt')).map((term) => [term.innerText, term.nextElementSibling?.innerText ?? '']))
})()`

/** The standing lines now on the page; agent-browser may print the JSON as a JSON string. */
async function standingNow(run) {
  const value = JSON.parse(await run(['eval', 'JSON.stringify(' + standing + ')']))
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** Type one message into the composer, press Send and wait for its Run to settle. */
async function send(state, id, run, prompt, runs, directory) {
  // A model question replaces the ordinary composer; the Person's progress answers it there.
  const message = JSON.parse(await run(['eval', 'Boolean(document.querySelector(\'[aria-label="Message Vivid"]\'))']))
  await run(['find', 'label', message ? 'Message Vivid' : 'Reply', 'fill', prompt])
  await run(['find', 'role', 'button', 'click', '--name', message ? 'Send' : 'Submit answer', '--exact'])
  const detail = await settled(state, id, runs, 'Completed', directory)
  return detail.runs[runs - 1].submissionId
}

/**
 * The Person makes a Project, tells Vivid in a Thread through the composer what done means and
 * then how it moved, opens the Project's page and reads its goal, latest dated progress and next
 * step under "Where it stands", and reads the same after a reload.
 */
export async function projectsBrowser(state, id, directory, { run, capture }) {
  assert.equal(
    state.modelKind,
    'real',
    'Project state needs a real model; rehearsal cannot prove it',
  )
  const created = await createProject(state, directory)

  const definedRun = await send(state, id, run, DEFINE_PROMPT, 1, directory)
  await updateCalls(state, id, definedRun, directory, 'define')
  assertDefined(await projectNow(state, created, directory, 'defined'))
  const before = Date.now()
  const progressRun = await send(state, id, run, PROGRESS_PROMPT, 2, directory)
  await updateCalls(state, id, progressRun, directory, 'progress')
  const project = await projectNow(state, created, directory, 'progressed')
  assertProgressed(project, before)
  await capture('thread')

  await run(['open', state.web + '/projects/' + encodeURIComponent(created.id)])
  await run(['wait', '--text', 'Where it stands'])
  const drawn = await standingNow(run)
  await capture('project')
  await json(directory + '/drawn.json', drawn)
  assert.ok(drawn, 'The page has no "Where it stands" part')
  assert.equal(drawn.Goal, project.work.objective, 'The page does not show the objective')
  assert.ok(
    drawn.Latest?.startsWith(project.work.progress.at(-1).text),
    'The page does not show the latest progress line',
  )
  assert.equal(drawn.Next, project.work.nextStep, 'The page does not show the next step')

  await run(['reload'])
  await run(['wait', '--text', 'Where it stands'])
  const reloaded = await standingNow(run)
  assert.deepEqual(reloaded, drawn, 'The page changed after reload')
  await capture('reloaded')
  await json(directory + '/scope.json', {
    proved:
      'Composer messages recorded by the real model as a Project objective and a dated progress line; the web Project page shows Goal, Latest and Next, unchanged after reload.',
    unsupported: ['completion and its proof link on the page', 'native phone and desktop pages'],
  })
}
