import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import { history, json, settled, rpc } from './wire.mjs'
import { assertTable } from './table.mjs'
import { asked, offered } from './offer.mjs'
import { streaming, textOf } from './phoneui.mjs'
import { control } from './socket.mjs'
import { observe } from './observation.mjs'
import { InputAnswer } from '@vivid/contracts'

const longReply =
  'Begin with amber-orchid. Write a detailed 3000-word guide to planning a community garden directly in this reply as plain paragraphs. Do not create a document or ask questions. End with orchid-complete.'
const saved = (page) => page.messages.map(({ id, role, parts }) => ({ id, role, parts }))

/** Type and send on Android, observe streaming, then prove both navigation and process recovery. */
export async function send(state, id, ui) {
  await ui.send(longReply)
  await ui.visible('Vivid: Thinking')
  await ui.capture('reduced-orb-first')
  await ui.capture('reduced-orb-second')
  await streaming(state, id, ui.directory)
  await ui.visible('amber-orchid')
  await ui.capture('streaming')
  const first = await ui.completed(id, 1, 'first')
  NodeAssert.match(first.reply, /amber-orchid/iu)
  await ui.create('Phone away ' + crypto.randomUUID().slice(0, 8))
  await ui.visit(id)
  await ui.visible('amber-orchid')
  await ui.capture('reopened')
  await ui.run(['close', 'work.vivid.mobile'])
  await ui.run(['open', 'work.vivid.mobile', '--relaunch'])
  await ui.visit(id)
  await ui.visible('amber-orchid')
  NodeAssert.deepEqual(
    saved(await history(state, id, ui.directory, 'relaunched')),
    saved(first.page),
  )
  await ui.capture('relaunched')
  await ui.send('What marker began your previous answer? Reply with the marker only.')
  const second = await ui.completed(id, 2, 'followup')
  NodeAssert.match(second.reply, /amber-orchid/iu)
  NodeAssert.equal(second.page.messages.filter((message) => message.role === 'user').length, 2)
  await ui.visible('amber-orchid')
  await ui.capture('followup')
}

/** Compare the chip selected on Android with its stored offer and the next Person contribution. */
export async function replies(state, id, ui) {
  await ui.send(asked)
  const first = await ui.completed(id, 1, 'offered')
  const choices = offered(first.page)
  NodeAssert.ok(choices.length > 0 && choices.length <= 3, 'No bounded suggested replies')
  for (const choice of choices) await ui.visible(choice)
  await ui.capture('offered')
  await ui.press(choices[0])
  const next = await ui.completed(id, 2, 'after-tap')
  const people = next.page.messages.filter((message) => message.role === 'user')
  NodeAssert.equal(people.length, 2)
  NodeAssert.equal(textOf([people[1]]).trim(), choices[0])
  await json(ui.directory + '/chosen.json', { choices, sent: textOf([people[1]]) })
  await ui.capture('after-tap')
}

/** The model must ask the same Cedar/Willow question as web; one-choice phone rows auto-submit. */
export async function question(state, id, ui) {
  await ui.send(
    'Before writing a one-sentence garden plan, ask me to choose its name using a question card. Offer exactly Cedar and Willow as alternatives, with one choice allowed. Do not choose for me. After I answer, write the plan with my chosen name.',
  )
  const pending = await settled(state, id, 1, 'Completed', ui.directory)
  NodeAssert.equal(pending.requests.length, 1)
  const request = pending.requests[0]
  NodeAssert.equal(request.state._tag, 'Waiting')
  NodeAssert.equal(request.questions.length, 1)
  const choice = request.questions[0]
  NodeAssert.equal(choice.selection, 'One')
  NodeAssert.deepEqual(choice.options.map((option) => option.label).toSorted(), ['Cedar', 'Willow'])
  const cedar = choice.options.find((option) => option.label === 'Cedar')
  const label = [cedar.label, cedar.detail].filter((words) => words.length > 0).join(', ')
  await ui.visible(label)
  await ui.capture('question')
  await ui.press(label)
  const done = await ui.completed(id, 2, 'answered')
  const answered = done.detail.requests.find((entry) => entry.id === request.id)
  NodeAssert.equal(answered.state._tag, 'Answered')
  NodeAssert.deepEqual(answered.state.answers, [
    InputAnswer.cases.Chosen.make({ labels: ['Cedar'] }),
  ])
  NodeAssert.equal(done.detail.runs[1].origin._tag, 'Decision')
  NodeAssert.match(done.reply, /Cedar/u)
  await ui.visible('Cedar')
  await ui.capture('answered')
}

/** Android Stop must abort the observed submission and retain its partial through reopen. */
export async function stop(state, id, ui) {
  await ui.send(longReply)
  const active = await streaming(state, id, ui.directory)
  await ui.visible('amber-orchid')
  await ui.capture('before-stop')
  await ui.press('Stop Vivid')
  const ended = await settled(state, id, 1, 'Stopped', ui.directory)
  NodeAssert.equal(ended.runs[0].id, active.run.id)
  const page = await history(state, id, ui.directory, 'stopped')
  NodeAssert.equal(page.working, false)
  NodeAssert.equal(page.queued, 0)
  NodeAssert.deepEqual(page.settlements, [
    { submissionId: active.run.submissionId, outcome: 'aborted' },
  ])
  NodeAssert.ok(
    textOf(page.messages.filter((message) => message.role === 'assistant')).startsWith(
      active.partial,
    ),
  )
  await ui.create('Stop away ' + crypto.randomUUID().slice(0, 8))
  await ui.visit(id)
  await ui.visible('amber-orchid')
  NodeAssert.deepEqual(saved(await history(state, id, ui.directory, 'reopened')), saved(page))
  await ui.capture('stopped-reopened')
  await ui.send('Reply with the word resumed only.')
  const next = await ui.completed(id, 2, 'resumed')
  NodeAssert.equal(next.detail.runs[0].state._tag, 'Stopped')
  NodeAssert.match(next.reply, /resumed/iu)
  await ui.visible('resumed')
  await ui.capture('resumed')
}

/** Keep Android on the Thread across a real native owner handoff and require the same Run. */
export async function move(state, id, ui) {
  await ui.send(longReply)
  const active = await streaming(state, id, ui.directory)
  await ui.visible('amber-orchid')
  await ui.capture('before-move')
  const before = await control(state, { action: 'cell', operation: 'state', role: 'runtime' })
  const residents = before.nodes.flatMap((node) =>
    node.state.residents.map((scope) => ({ scope, role: node.role })),
  )
  NodeAssert.equal(residents.length, 1, 'Expected the launch to own exactly one Person cell')
  const owner = residents[0]
  const moved = await control(state, { action: 'cell', operation: 'move', role: owner.role })
  const done = await ui.completed(id, 1, 'moved')
  NodeAssert.equal(done.detail.runs[0].id, active.run.id)
  NodeAssert.equal(done.detail.runs[0].submissionId, active.run.submissionId)
  NodeAssert.equal(done.page.messages.filter((message) => message.role === 'user').length, 1)
  NodeAssert.ok(
    done.reply.startsWith(active.partial),
    'Owner move changed the already-streamed prefix',
  )
  const after = await control(state, { action: 'cell', operation: 'state', role: 'runtime' })
  const next = after.nodes.filter((node) => node.state.residents.includes(owner.scope))
  NodeAssert.equal(next.length, 1)
  NodeAssert.notEqual(next[0].role, owner.role, 'Native receipts did not prove an owner change')
  await json(ui.directory + '/ownership.json', {
    before,
    moved,
    after,
    owner,
    successor: next[0].role,
  })
  await ui.visible('amber-orchid')
  await ui.visible('orchid-complete')
  await ui.capture('after-move')
}

/** A real offscreen Run must become unread; the phone's drawer has titles and no preview text. */
export async function feed(state, id, ui) {
  await ui.send(longReply)
  await streaming(state, id, ui.directory)
  await ui.menu()
  await ui.press('Feed')
  await ui.visible('Message Vivid')
  await ui.capture('feed-open')
  await ui.completed(id, 1, 'offscreen')
  const list = await observe(state, {
    tag: 'WatchThreads',
    payload: null,
    accept: (value) =>
      value.threads.some((thread) => thread.id === id && thread.attention === 'Unread'),
  })
  await json(ui.directory + '/unread.json', list)
  const unread = list.threads.find((entry) => entry.id === id)
  await ui.menu()
  await ui.visible(unread.title)
  await ui.capture('unread-list')
  await json(ui.directory + '/scope.json', {
    claim:
      'Feed opened; an offscreen completed Thread became Unread and is visible in the phone list.',
    unsupported:
      'Last-message previews are deliberately absent in screen/home/Row.tsx. Bold text and the unread dot need screenshot inspection.',
  })
}

/** Push real PNG bytes into Android's media store, select through its system picker, then reopen. */
export async function picture(state, id, ui, adb) {
  // A large opaque red PNG makes model recognition meaningful; HTTP and screenshots retain bytes.
  const file = ui.directory + '/red.png'
  const { command } = await import('./process.mjs')
  await command([
    'python3',
    '-c',
    'import struct,zlib,sys; c=lambda t,b:struct.pack(">I",len(b))+t+b+struct.pack(">I",zlib.crc32(t+b)); n=96; raw=(b"\\0"+b"\\xff\\0\\0"*n)*n; open(sys.argv[1],"wb").write(b"\\x89PNG\\r\\n\\x1a\\n"+c(b"IHDR",struct.pack(">2I5B",n,n,8,2,0,0,0))+c(b"IDAT",zlib.compress(raw))+c(b"IEND",b""))',
    file,
  ])
  await adb(['push', file, '/sdcard/Pictures/vivid-red.png'])
  await adb([
    'shell',
    'am',
    'broadcast',
    '-a',
    'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
    '-d',
    'file:///sdcard/Pictures/vivid-red.png',
  ])
  await ui.press('Attach files')
  await ui.press('Photos')
  // Android supplies these accessibility names, not the Vivid source. Retain a fresh tree and
  // fail visibly if this API-35 picker differs; do not substitute an RPC upload for a phone tap.
  await ui.run(['snapshot', '-i', '--force-full'])
  await ui.press('Photo taken on', 'image')
  await ui.press('Add')
  await ui.send(
    'What is the dominant color of the attached picture? Reply with one color word only.',
  )
  const done = await ui.completed(id, 1, 'picture')
  NodeAssert.match(done.reply.trim(), /^red[.!]?$/iu)
  const files = done.page.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'file')
  NodeAssert.equal(files.length, 1)
  await json(ui.directory + '/attachment.json', files[0])
  await ui.capture('picture-sent')
  await ui.create('Picture away ' + crypto.randomUUID().slice(0, 8))
  await ui.visit(id)
  await ui.visible(done.reply.trim())
  const reopened = await history(state, id, ui.directory, 'picture-reopened')
  NodeAssert.deepEqual(saved(reopened), saved(done.page))
  await ui.capture('picture-reopened')
  NodeAssert.ok((await NodeFSP.readFile(file)).length > 0)
}

/** The phone must render the model's real OpenUI cells, separately from its stored program. */
export async function tool(state, id, ui) {
  await ui.send(
    'Show a rich interactive table using an openui-lang Table, not Markdown. Columns Project, Hours, Owner. Rows Research | 4 | Ada, Writing | 3 | Ben, Review | 2 | Cai. Title Workload.',
  )
  const done = await ui.completed(id, 1, 'table')
  await assertTable(done.page)
  await ui.visible('Hours')
  const drawn = await ui.capture('table')
  for (const cell of [
    'Project',
    'Hours',
    'Owner',
    'Research',
    '4',
    'Ada',
    'Writing',
    '3',
    'Ben',
    'Review',
    '2',
    'Cai',
  ])
    NodeAssert.ok(drawn.includes(JSON.stringify(cell)), 'Native table omitted a cell: ' + cell)
  await ui.create('Table away ' + crypto.randomUUID().slice(0, 8))
  await ui.visit(id)
  await ui.visible('Hours')
  await ui.capture('table-reopened')
}

/** Create and revise through Android's composer; immutable Artifact receipts establish the body.
 * The phone has no GetArtifact caller, so this journey makes no native Artifact-opener claim. */
export async function document(state, id, ui) {
  await ui.send(
    'Write me a document called Verification plan with the body: # Verification plan\nResearch, writing and review. Then say Plan saved in this reply.',
  )
  await ui.completed(id, 1, 'created')
  const created = await rpc(
    state,
    'ListArtifacts',
    { threadId: id },
    ui.directory,
    'created-artifacts',
  )
  NodeAssert.equal(created.artifacts.length, 1)
  const artifact = created.artifacts[0]
  NodeAssert.equal(artifact.title, 'Verification plan')
  NodeAssert.equal(artifact.version, 1)
  await ui.visible('Plan saved')
  await ui.capture('document-created')
  await ui.send(
    'Add the sentence Ready for review to the end of the Verification plan document. Then say Plan updated in this reply.',
  )
  const revised = await ui.completed(id, 2, 'revised')
  const list = await rpc(
    state,
    'ListArtifacts',
    { threadId: id },
    ui.directory,
    'revised-artifacts',
  )
  NodeAssert.equal(list.artifacts.length, 1)
  NodeAssert.equal(list.artifacts[0].id, artifact.id)
  NodeAssert.equal(list.artifacts[0].version, 2)
  const first = await rpc(
    state,
    'GetArtifact',
    { id: artifact.id, version: 1 },
    ui.directory,
    'version-1',
  )
  const second = await rpc(
    state,
    'GetArtifact',
    { id: artifact.id, version: 2 },
    ui.directory,
    'version-2',
  )
  NodeAssert.match(second.body, /Ready for review/u)
  NodeAssert.notEqual(first.body, second.body)
  await ui.visible('Plan updated')
  await ui.capture('document-revised')
  await ui.create('Document away ' + crypto.randomUUID().slice(0, 8))
  await ui.visit(id)
  await ui.visible('Plan updated')
  NodeAssert.deepEqual(
    saved(await history(state, id, ui.directory, 'document-reopened')),
    saved(revised.page),
  )
  await ui.capture('document-reopened')
}
