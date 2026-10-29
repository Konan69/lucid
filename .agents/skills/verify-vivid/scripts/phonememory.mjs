import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import { history, json, rpc } from './wire.mjs'
import { MemorySource } from '@vivid/contracts'
import { learned } from './learning.mjs'

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

/**
 * A new Thread must answer from the first Thread's memory. A new Thread has no other source for
 * the project's meeting time, so the answer is the proof. The prompt tells Vivid to use an index
 * line directly when it is enough and to call read_memory only when it is not, so either path
 * passes; the receipt records which one was taken.
 */
export async function memory(state, id, ui) {
  const { marker, entry } = await preference(state, id, ui)
  const next = await ui.create('Recall ' + marker)
  await ui.send(`When do I like to have meetings for project ${marker}, and why?`)
  const recalled = await ui.completed(next, 1, 'recalled')
  NodeAssert.match(recalled.reply, /noon/iu)
  NodeAssert.match(recalled.reply, /writ/iu)
  const read = calls(recalled.page, recalled.detail.runs[0], 'read_memory').some(
    (call) => call.output.file === entry.file && call.output.layer === entry.layer,
  )
  await NodeFSP.writeFile(
    NodePath.join(ui.directory, 'recall-path.json'),
    JSON.stringify({ path: read ? 'read_memory' : 'index', file: entry.file }, null, 2),
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
  // Android's native AlertDialog draws its buttons in capitals, and that is their accessible label.
  await ui.press('FORGET')
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

/** Both native and HTTP journeys judge the same fact after its learner task is terminal. */
export async function learningFact(state, directory, marker, exchange) {
  const run = exchange.detail.runs[0]
  const writes = calls(exchange.page, run, 'write_memory')
  await learned(state, run.submissionId, directory)
  const { entries } = await remembered(state, directory, marker, 'learned')
  NodeAssert.equal(entries.length, 1, 'The fact must be saved once after learning completes')
  NodeAssert.match(entries[0].body, /green tea/iu)
  if (writes.length > 0) {
    NodeAssert.equal(writes.length, 1, 'The reply wrote the fact more than once')
    NodeAssert.equal(entries[0].file, writes[0].output.file)
    NodeAssert.equal(entries[0].layer, writes[0].output.layer)
    NodeAssert.ok(
      !MemorySource.guards.CellRun(entries[0].authority.source),
      'Learner rewrote the reply-saved fact',
    )
  } else {
    NodeAssert.ok(
      MemorySource.guards.CellRun(entries[0].authority.source),
      'The learner did not save the fact',
    )
  }
  await json(directory + '/learning-path.json', {
    path: writes.length > 0 ? 'reply' : 'learner',
  })
}

/** The learner backs up reply writes. Wait for its native terminal receipt before counting facts. */
export async function learning(state, id, ui) {
  const marker = 'Teacup-' + crypto.randomUUID().slice(0, 8)
  await ui.send(
    `For project ${marker}, I always choose green tea at the planning sessions. Just acknowledge briefly.`,
  )
  const exchange = await ui.completed(id, 1, 'exchange')
  await learningFact(state, ui.directory, marker, exchange)
  await ui.capture('exchange')
  const next = await ui.create('Learning recall ' + marker)
  await ui.send(`What drink do I always choose at the planning sessions for project ${marker}?`)
  const recalled = await ui.completed(next, 1, 'learning-recalled')
  NodeAssert.match(recalled.reply, /green tea/iu)
  await ui.visible('green tea')
  await ui.capture('learning-recalled')
  await json(ui.directory + '/scope.json', {
    decisions: 'off',
    reason:
      'The launcher does not forward VIVID_DECISIONS into native Worker vars; runtime defaults off.',
    observation:
      'LearnedRun and its terminal native task are observed before the public memory snapshot and new-Thread recall. Reply writes and learner writes must leave exactly one matching entry.',
  })
  await history(state, id, ui.directory, 'original-after-learning')
}
