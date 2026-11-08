import * as NodeAssert from 'node:assert/strict'
import { Tool } from '@vivid/contracts'
import {
  ADD_PROMPT,
  DONE_PROMPT,
  PRESS_PROMPT,
  addedTodo,
  dentist,
  lastRun,
  passport,
  toolReceipt,
} from './todos.mjs'
import { json, settled } from './wire.mjs'

/** Whether the Feed draws an open to-do row with these words, read from the rendered page. */
const rowShown = (what) => `(() => {
  const list = document.querySelector('[aria-labelledby="todos-heading"]')
  return Boolean(list && Array.from(list.querySelectorAll('li')).some((row) => !row.hasAttribute('data-folded') && row.innerText.includes(${JSON.stringify(what)})))
})()`

/**
 * The Person's list through the web client: "renew my passport" said in the composer appears
 * under "To do" on the Feed; "I renewed it" in the same Thread takes it off; a second to-do added
 * there is ticked off by the row's own check on the Feed, folds at once and stays gone after a
 * reload, and the public list keeps both as Done.
 */
export async function todosBrowser(state, id, directory, { run, capture }) {
  NodeAssert.equal(
    state.modelKind,
    'real',
    'The list needs a real model; rehearsal cannot prove it',
  )
  const journey = { state, id, directory }
  const thread = state.web + '/t/' + id
  const send = async (words, runs) => {
    await run(['find', 'label', 'Message Vivid', 'fill', words])
    await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    return lastRun(await settled(state, id, runs, 'Completed', directory))
  }

  await toolReceipt(journey, await send(ADD_PROMPT, 1), Tool.add_todo)
  const todo = await addedTodo(journey, passport, 'listed')
  await capture('thread')
  await run(['open', state.web + '/feed'])
  await run(['wait', '--text', 'To do'])
  await run(['wait', '--fn', rowShown(todo.what)])
  await capture('feed')

  await run(['open', thread])
  await run(['wait', '[aria-label="Message Vivid"]'])
  await toolReceipt(journey, await send(DONE_PROMPT, 2), Tool.complete_todo)
  const renewed = await addedTodo(journey, passport, 'renewed')
  NodeAssert.equal(renewed.state._tag, 'Done', '"I renewed it" did not tick the to-do off')
  await toolReceipt(journey, await send(PRESS_PROMPT, 3), Tool.add_todo)
  const second = await addedTodo(journey, dentist, 'second')
  await capture('ticked')

  await run(['open', state.web + '/feed'])
  await run(['wait', '--fn', rowShown(second.what)])
  const gone = await run(['eval', rowShown(todo.what)])
  NodeAssert.equal(gone.trim(), 'false', 'The renewed passport is still on the Feed')
  await capture('feed-second')
  await run(['find', 'role', 'button', 'click', '--name', 'Done: ' + second.what, '--exact'])
  await run(['wait', '--fn', '!' + rowShown(second.what)])
  await capture('pressed')

  await run(['reload'])
  await run(['wait', '[aria-label="Message Vivid"]'])
  const after = await run(['eval', rowShown(second.what)])
  NodeAssert.equal(after.trim(), 'false', 'The ticked-off row came back after reload')
  const pressed = await addedTodo(journey, dentist, 'pressed')
  NodeAssert.equal(pressed.state._tag, 'Done', 'The Feed check did not tick the to-do off')
  await capture('reloaded')
  await json(directory + '/scope.json', {
    proved:
      'Composer sentence added by the real model, the row under "To do" on the web Feed, "I renewed it" ticking it off through the model, and the row\'s own check ticking off a second one, folded at once and absent after reload.',
    unsupported: [
      'Remove from list through the row menu',
      'calendar placement',
      'native phone and desktop controls',
    ],
  })
}
