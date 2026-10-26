import * as NodeAssert from 'node:assert/strict'
import { json, history, rpc, settled } from './wire.mjs'
import { BROWSER_NAME as NAME, nameLimits, answered } from './nameproof.mjs'

/** Text of the open Settings dialog, read from the page itself. */
const dialogText = `(document.querySelector('[role="dialog"]')?.innerText ?? '')`

/**
 * The Person changes their name in the real Settings dialog, sees it there and after a reload,
 * then asks Vivid in their own words. The answer must be a visible Vivid bubble that says the new
 * name; the Person's own message cannot satisfy it.
 */
export async function nameBrowser(state, id, directory, browser) {
  const { run, capture } = browser
  const before = await rpc(state, 'Me', undefined, directory, 'me-before')
  NodeAssert.notEqual(before.person.name, NAME, 'Recipe needs a Person not yet called ' + NAME)
  await run(['open', state.web + '/t/' + id + '?settings=general'])
  await run(['wait', '--fn', `${dialogText}.includes('What Vivid calls you')`])
  await capture('settings-before')
  await run(['find', 'role', 'button', 'click', '--name', 'Change', '--exact'])
  await run(['wait', '--fn', `Boolean(document.querySelector('input[autocomplete="name"]'))`])
  await run(['find', 'label', 'Your name', 'fill', NAME])
  await capture('name-form')
  await run(['find', 'role', 'button', 'click', '--name', 'Save', '--exact'])
  // The machine closes the form only once the server has taken the name.
  await run([
    'wait',
    '--fn',
    `!document.querySelector('input[autocomplete="name"]') && ${dialogText}.includes(${JSON.stringify(NAME)})`,
  ])
  await capture('settings-renamed')
  const after = await rpc(state, 'Me', undefined, directory, 'me-after')
  NodeAssert.equal(after.person.name, NAME)
  await run(['reload'])
  await run(['wait', '--fn', `${dialogText}.includes(${JSON.stringify(NAME)})`])
  await capture('settings-reloaded')

  await run(['open', state.web + '/t/' + id])
  await run(['wait', '[aria-label="Message Vivid"]'])
  await run(['find', 'label', 'Message Vivid', 'fill', 'what’s my name?'])
  await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  await settled(state, id, 1, 'Completed', directory)
  const page = await history(state, id, directory)
  const reply = answered(page, NAME)
  await run([
    'wait',
    '--fn',
    `Array.from(document.querySelectorAll('[data-vivid-bubble]')).some(b => b.innerText.toLowerCase().includes(${JSON.stringify(NAME.split(' ')[0].toLowerCase())}))`,
  ])
  await capture('thread-answer')
  await json(directory + '/scope.json', { reply, name: NAME, blocked: nameLimits })
}
