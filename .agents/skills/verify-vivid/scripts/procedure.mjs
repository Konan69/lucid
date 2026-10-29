import * as fs from 'node:fs/promises'
import * as assert from 'node:assert/strict'
import { Tool } from '@vivid/contracts'
import { chat, settled, history, json, rpc } from './wire.mjs'

/**
 * Teaching Vivid a task by walking it through once, asked as a Person asks: no prompt names a
 * tool, a skill or a procedure. The walkthrough spans three messages and corrects one value in the
 * last; Vivid must learn it without doing it, and a second Thread asking for the task with another
 * input must get the corrected rule.
 *
 * The category table is the decisive rule and is longer than the 4,000 characters a tool result
 * kept before: its last row, the one the second Thread asks about and the one corrected, sits past
 * that point wherever the table lands in what Vivid saves. Each recipe draws its own vendor tag
 * and codes, so the HTTP and browser runs on one launch cannot answer from each other's work.
 */
export function procedureSteps() {
  const tag = crypto.randomUUID().slice(0, 6).toUpperCase()
  const wrong = 'TR-' + (100 + Math.floor(Math.random() * 400))
  const code = 'TR-' + (500 + Math.floor(Math.random() * 400))
  const last = `Zephyr Rail ${tag}`
  const kinds = [
    ['TX', 'taxis and ride-hailing inside the city, including airport pickups and drop-offs'],
    ['HT', 'hotel nights, including the room tax and breakfast when it is on the same bill'],
    ['ML', 'meals while travelling, one line per receipt, tips included in the amount'],
    ['TR', 'rail and coach tickets between cities, seat reservations and booking fees'],
  ]
  const rows = Array.from({ length: 59 }, (_, index) => {
    const [prefix, covers] = kinds[index % kinds.length]
    const number = String(index + 1).padStart(2, '0')
    return `- Vendor ${number} ${tag} (any city): code ${prefix}-${number}, for ${covers}.`
  })
  rows.push(`- ${last} (any city): code ${wrong}, for ${kinds[3][1]}.`)
  const table = rows.join('\n')
  assert.ok(table.indexOf(last) > 4000, 'The decisive row must sit past 4,000 characters')
  return {
    tag,
    last,
    code,
    wrong,
    teach: [
      `I want to show you how I file a travel expense, so you can do it for me from now on. I will walk you through it in three messages; do not file anything and do not learn it until I say that is everything. Here is how I do it. I start from one receipt. I note the vendor, the date and the amount. I look the vendor up in my category table to get its code. Then I write one expense line exactly like this: "<date> | <vendor> | <amount> | <code>". If the amount is over 200 dollars I ask my manager to approve the line before it is submitted; at 200 or less I submit it myself. It is done when the line is written with the right code.`,
      `This is my category table. Keep it word for word, every row, because I use the exact codes:\n${table}`,
      `One correction to the table: ${last} is code ${code}, not ${wrong}. That is everything; please learn how I file a travel expense.`,
    ],
    apply: `Please do my travel expense: ${last}, 12 March 2026, 48 dollars. Just write me the expense line; I will submit it myself.`,
  }
}

/** What Vivid said and called in one Run, read from the Thread's history. */
function runOf(page, run) {
  const replies = page.messages.filter(
    (message) => message.role === 'assistant' && message.submissionId === run,
  )
  const parts = replies.flatMap((message) => message.parts)
  return {
    calls: parts.filter((part) => part.type === 'dynamic-tool'),
    text: parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim(),
  }
}

/** Learning a task never does it: nothing that acts outside the Thread or arranges later work. */
const ACTING = [Tool.use_tool, Tool.watch, Tool.post, Tool.make_integration, Tool.notify_person]
/** Vivid speaks of the work, never of how it keeps it (`learn-how-we-do-this`). */
const PLUMBING = /\b(skills?|procedures?)\b|save_skill|read_skill|activate_skill/iu

/** One Run's receipts: no acting tool, no word about skills, and a reply. */
function quiet(page, run, name) {
  const { calls, text } = runOf(page, run)
  for (const call of calls)
    assert.ok(!ACTING.includes(call.toolName), `${name} called ${call.toolName}`)
  assert.doesNotMatch(text, PLUMBING, `${name} told the Person about skills`)
  return { calls, text }
}

/** A successful call of one tool whose output holds `marker`. */
const succeeded = (calls, tool, marker) =>
  calls.find(
    (part) =>
      part.toolName === tool &&
      part.state === 'output-available' &&
      JSON.stringify(part.output).includes(marker),
  )

/**
 * The walkthrough's Runs: Vivid learned it once, after the correction, and read it back whole. The
 * saved copy is read through the public `ListSkills`: personal, with the corrected code on the row
 * past 4,000 characters.
 */
export async function taught(state, { id, detail, steps }, directory) {
  const page = await history(state, id, directory, 'taught-history')
  const runs = detail.runs.map((run) => run.submissionId)
  const seen = runs.map((run, index) => quiet(page, run, 'Walkthrough turn ' + (index + 1)))
  const calls = seen.flatMap((turn) => turn.calls)
  const saves = calls.filter(
    (part) => part.toolName === Tool.save_skill && part.state === 'output-available',
  )
  assert.equal(saves.length, 1, 'Vivid did not learn the task exactly once')
  assert.ok(
    seen.slice(0, -1).every((turn) => !turn.calls.includes(saves[0])),
    'Vivid learned the task before the walkthrough ended',
  )
  assert.ok(String(saves[0].input.instructions).includes(steps.code), 'The correction was not kept')
  assert.ok(
    succeeded(calls, Tool.read_skill, steps.code),
    'Vivid did not read the whole saved task back',
  )
  const list = await rpc(state, 'ListSkills', undefined, directory, 'skills')
  const saved = list.skills.filter((skill) => skill.instructions.includes(steps.last))
  assert.equal(saved.length, 1, 'Expected one saved task for this walkthrough')
  const [skill] = saved
  assert.equal(skill.scope._tag, 'Personal', 'A personal walkthrough was saved for the Company')
  const row = skill.instructions.lastIndexOf(steps.last)
  assert.ok(row > 4000, 'Fixture: the saved task did not place the decisive row past 4,000 characters')
  assert.ok(skill.instructions.slice(row).includes(steps.code), 'The saved row lost the correction')
  assert.ok(seen.at(-1).text.length > 0, 'Vivid did not say what it learned')
  await json(directory + '/taught.json', {
    runs,
    skill: { name: skill.name, scope: skill.scope, characters: skill.instructions.length, row },
    acknowledged: seen.at(-1).text,
  })
  return skill
}

/** The second Thread's Run: it read the task whole and applied the corrected code to a new receipt. */
export async function applied(state, { id, detail, steps }, directory) {
  const page = await history(state, id, directory, 'applied-history')
  const run = detail.runs.at(-1).submissionId
  const { calls, text } = runOf(page, run)
  assert.doesNotMatch(text, PLUMBING, 'The reply told the Person about skills')
  assert.ok(succeeded(calls, Tool.read_skill, steps.code), 'Vivid did not read the task whole')
  assert.ok(text.includes(steps.code), 'The expense line does not use the corrected code')
  assert.ok(!text.includes(steps.wrong), 'The expense line uses the corrected-away code')
  assert.match(text, /48/u, 'The expense line lost the amount')
  await json(directory + '/applied.json', { run, text })
  return text
}

/** Person gateway admission and WatchThread settlement through the shipped teaching guidance. */
export async function procedure(state, id, directory) {
  assert.equal(state.modelKind, 'real', 'Teaching requires a real model; rehearsal cannot prove it')
  const steps = procedureSteps()
  await json(directory + '/steps.json', steps)
  let detail
  for (const [index, words] of steps.teach.entries()) {
    const evidence = directory + '/teach-' + (index + 1)
    await fs.mkdir(evidence, { recursive: true })
    await chat(state, id, words, evidence)
    detail = await settled(state, id, index + 1, 'Completed', evidence)
  }
  await taught(state, { id, detail, steps }, directory)
  const second = crypto.randomUUID()
  await rpc(state, 'CreateThread', { id: second, title: 'Expense', projectId: null }, directory)
  await chat(state, second, steps.apply, directory, 'apply')
  const done = await settled(state, second, 1, 'Completed', directory)
  await applied(state, { id: second, detail: done, steps }, directory)
  await json(directory + '/scope.json', {
    proved:
      'A three-message walkthrough with a correction is learned once without being done, read back whole past 4,000 characters, kept personal, and applied with the corrected rule to a new input in another Thread.',
    unsupported: ['browser-recorded demonstrations', 'Company procedures', 'native clients'],
  })
}
