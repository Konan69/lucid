import * as NodeAssert from 'node:assert/strict'
import { history, json, rpc } from './wire.mjs'
import { MemorySource } from '@vivid/contracts'

/** Only successful renamed tools count; prose claiming to remember is insufficient. */
const calls = (page, run, name) =>
  page.messages
    .filter((message) => message.role === 'assistant' && message.submissionId === run.submissionId)
    .flatMap((message) => message.parts)
    .filter(
      (part) =>
        part.type === 'dynamic-tool' && part.toolName === name && part.state === 'output-available',
    )

/** Index lines and standing pages share addresses; ReadMemory supplies full body and authority. */
async function remembered(state, directory, marker, name) {
  const index = await rpc(state, 'GetMemoryIndex', undefined, directory, name + '-index')
  const addresses = [...index.standing, ...index.lines]
  const entries = []
  for (const address of addresses)
    entries.push(
      await rpc(
        state,
        'ReadMemory',
        { layer: address.layer, file: address.file },
        directory,
        name + '-' + address.layer + '-' + address.file,
      ),
    )
  const matching = entries.filter(
    (entry) => entry.description.includes(marker) || entry.body.includes(marker),
  )
  await json(directory + '/' + name + '.json', { index, entries: matching })
  return { index, entries: matching }
}

/** Ask naturally for a unique project preference, then read its actual memory address. */
async function preference(state, id, ui) {
  const marker = 'Cedar-' + crypto.randomUUID().slice(0, 8)
  await ui.send(
    `Please remember that for project ${marker}, I prefer meetings before noon, because afternoons are for writing.`,
  )
  const created = await ui.completed(id, 1, 'remembered')
  const writes = calls(created.page, created.detail.runs[0], 'write_memory')
  NodeAssert.equal(writes.length, 1, 'No single successful write_memory receipt')
  const write = writes[0]
  NodeAssert.equal(write.output.ok, true)
  const entry = await rpc(
    state,
    'ReadMemory',
    { layer: write.output.layer, file: write.output.file },
    ui.directory,
    'saved-entry',
  )
  NodeAssert.match(entry.body, /noon/iu)
  await ui.capture('remembered')
  return { marker, entry }
}

/** A new Thread must recall the first Thread's memory through the renamed read_memory tool. */
export async function memory(state, id, ui) {
  const { marker, entry } = await preference(state, id, ui)
  const next = await ui.create('Recall ' + marker)
  await ui.send(`When do I like to have meetings for project ${marker}, and why?`)
  const recalled = await ui.completed(next, 1, 'recalled')
  NodeAssert.match(recalled.reply, /noon/iu)
  NodeAssert.match(recalled.reply, /writ/iu)
  NodeAssert.ok(
    calls(recalled.page, recalled.detail.runs[0], 'read_memory').some(
      (call) => call.output.file === entry.file && call.output.layer === entry.layer,
    ),
    'Recall did not read the same entry through read_memory',
  )
  await ui.visible('noon')
  await ui.capture('recalled')
  await remembered(state, ui.directory, marker, 'recall-index')
}

/** Android names these labelled inputs only "Text field": React Native's accessibilityLabel on a
 * TextInput does not reach agent-device's text-field name. The editor holds exactly two, in the
 * order What Vivid remembers, In full; fill them by that order inside the open correction sheet. */
async function correction(ui, values) {
  // `fill --settle` emits a new frame and agent-device then refuses refs from the one before
  // (29 October 2026: "Ref @e7 needs a complete snapshot"), so read the fields again per fill.
  for (const [index, value] of values.entries()) {
    const snapshot = await ui.run(['snapshot', '-i', '--force-full'])
    NodeAssert.ok(snapshot.includes('What Vivid remembers, In full'), snapshot)
    const fields = snapshot.split('\n').filter((line) => line.includes('[text-field]'))
    NodeAssert.equal(fields.length, 2, 'Expected the two correction fields\n' + snapshot)
    await ui.run(['fill', fields[index].match(/@e\d+(?:~s\d+)?/u)[0], value, '--settle'])
  }
}

/** U5's real editor corrects and forgets the entry written through the phone composer. */
export async function settingsMemory(state, id, ui) {
  const { marker, entry } = await preference(state, id, ui)
  const open = async () => {
    await ui.menu()
    await ui.press('Settings')
    await ui.press('What Vivid knows')
    await ui.visible(entry.description)
  }
  await open()
  await ui.capture('listed')
  await ui.press(entry.description)
  await ui.press('Correct')
  const description = `${marker} meetings after three; mornings are for writing.`
  await correction(ui, [description, description])
  await ui.press('Save correction')
  await ui.run(['wait', 'absent', 'label="Save correction"', '60000'])
  const corrected = await rpc(
    state,
    'ReadMemory',
    { layer: entry.layer, file: entry.file },
    ui.directory,
    'corrected',
  )
  NodeAssert.equal(corrected.description, description)
  NodeAssert.equal(corrected.body, description)
  NodeAssert.equal(corrected.authority.source._tag, 'Settings')
  NodeAssert.ok(corrected.revision > entry.revision)
  await ui.capture('corrected')
  await ui.run(['close', 'work.vivid.mobile'])
  await ui.run(['open', 'work.vivid.mobile', '--relaunch'])
  await ui.menu()
  await ui.press('Settings')
  await ui.press('What Vivid knows')
  await ui.visible(description)
  await ui.capture('correction-reopened')
  await ui.press(description)
  await ui.press('Forget this')
  await ui.press('Forget')
  await ui.run(['wait', 'absent', 'label=' + JSON.stringify(description), '60000'])
  await ui.capture('forgotten')
  await ui.run(['close', 'work.vivid.mobile'])
  await ui.run(['open', 'work.vivid.mobile', '--relaunch'])
  await ui.menu()
  await ui.press('Settings')
  await ui.press('What Vivid knows')
  await ui.visible('What Vivid remembers')
  const reopened = await rpc(state, 'GetMemoryIndex', undefined, ui.directory, 'forgotten-index')
  NodeAssert.ok(
    ![...reopened.standing, ...reopened.lines].some(
      (line) => line.layer === entry.layer && line.file === entry.file,
    ),
  )
  await ui.run(['wait', 'absent', 'label=' + JSON.stringify(description), '60000'])
  await ui.capture('forgotten-reopened')
}

/** The reply must not save this fact. A CellRun entry and a new Thread's answer prove learning. */
export async function learning(state, id, ui) {
  const marker = 'Teacup-' + crypto.randomUUID().slice(0, 8)
  await ui.send(
    `For project ${marker}, I always choose green tea at the planning sessions. Just acknowledge briefly.`,
  )
  const exchange = await ui.completed(id, 1, 'exchange')
  NodeAssert.equal(
    calls(exchange.page, exchange.detail.runs[0], 'write_memory').length,
    0,
    'The reply wrote memory itself, so this exchange cannot prove background learning',
  )
  await ui.capture('exchange')
  const next = await ui.create('Learning recall ' + marker)
  await ui.send(`What drink do I always choose at the planning sessions for project ${marker}?`)
  const recalled = await ui.completed(next, 1, 'learning-recalled')
  NodeAssert.match(recalled.reply, /green tea/iu)
  const { entries } = await remembered(state, ui.directory, marker, 'learned')
  NodeAssert.ok(
    entries.some(
      (entry) =>
        MemorySource.guards.CellRun(entry.authority.source) && /green tea/iu.test(entry.body),
    ),
    'No matching CellRun memory at the observed public snapshot',
  )
  await ui.visible('green tea')
  await ui.capture('learning-recalled')
  await json(ui.directory + '/scope.json', {
    decisions: 'off',
    reason:
      'The launcher does not forward VIVID_DECISIONS into native Worker vars; runtime defaults off.',
    observation:
      'Public memory is checked after a real new-Thread recall, without sleeps or polling. There is no public learner-completion stream. A missing entry can be a still-pending task, not proof learning never runs.',
  })
  await history(state, id, ui.directory, 'original-after-learning')
}
