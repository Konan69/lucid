import * as NodeAssert from 'node:assert/strict'
import { Tool } from '@vivid/contracts'
import { chat, history, json, rpc, settled } from './wire.mjs'

/**
 * What a Person says to put something on their own list, and to say it is done. No tool, field or
 * date format is named (the owner, 26 October 2026: ask as a Person asks).
 */
export const ADD_PROMPT = 'Add renew my passport to my list.'
export const DONE_PROMPT = 'I renewed it.'
/** A second to-do for the browser's own press on the Feed row. */
export const PRESS_PROMPT = 'Also add book the dentist to my list.'

export const passport = /passport/iu
export const dentist = /dentist/iu

/**
 * The one to-do this journey added that matches `thing`, read through the public list. Only
 * to-dos from this journey's Thread count: one Person may run several journeys.
 */
export async function addedTodo({ state, id, directory }, thing, name) {
  const listed = await rpc(state, 'ListTodos', undefined, directory, name)
  const matching = listed.todos.filter((todo) => todo.threadId === id && thing.test(todo.what))
  NodeAssert.equal(matching.length, 1, 'Expected one matching to-do, found ' + matching.length)
  return matching[0]
}

/**
 * The Thread steps of one Run calling `tool`: exactly one, and it succeeded, so the Person's
 * sentence moved their list and was not only answered.
 */
export async function toolReceipt({ state, id, directory }, run, tool) {
  const page = await history(state, id, directory, tool + '-history')
  const calls = page.messages
    .filter((message) => message.role === 'assistant' && message.submissionId === run)
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'dynamic-tool' && part.toolName === tool)
  await json(directory + '/' + tool + '-calls.json', calls)
  NodeAssert.equal(calls.length, 1, 'Expected one ' + tool + ' call, found ' + calls.length)
  NodeAssert.equal(calls[0].state, 'output-available')
  return calls[0]
}

/** The newest Run of a settled Thread, by its place in the Thread: the one the last sentence started. */
export const lastRun = (detail) =>
  detail.runs.toSorted((a, b) => a.turn - b.turn).at(-1).submissionId

/**
 * The to-do journey through the server's public surfaces: the Person asks Vivid in a Thread to
 * put "renew my passport" on their list, the to-do appears open in the list the Feed draws
 * (`ListTodos`, the projection `WatchTodos` publishes) naming that Thread, and "I renewed it" in
 * the same Thread has Vivid tick it off, which the server keeps as Done.
 */
export async function todos(state, id, directory) {
  NodeAssert.equal(
    state.modelKind,
    'real',
    'The list needs a real model; rehearsal cannot prove it',
  )
  const journey = { state, id, directory }
  await chat(state, id, ADD_PROMPT, directory, 'add')
  const added = await settled(state, id, 1, 'Completed', directory)
  await toolReceipt(journey, lastRun(added), Tool.add_todo)
  const todo = await addedTodo(journey, passport, 'listed')
  NodeAssert.equal(todo.state._tag, 'Open', 'The new to-do is not open')

  await chat(state, id, DONE_PROMPT, directory, 'done')
  const done = await settled(state, id, 2, 'Completed', directory)
  await toolReceipt(journey, lastRun(done), Tool.complete_todo)
  const closed = await addedTodo(journey, passport, 'completed')
  NodeAssert.equal(closed.state._tag, 'Done', '"I renewed it" did not tick the to-do off')
  NodeAssert.equal(closed.id, todo.id, 'A different to-do was ticked off')
  await json(directory + '/scope.json', {
    proved:
      'Real model adds a to-do said in a Thread; it is listed open with its Thread; "I renewed it" has the model tick it off, kept as Done.',
    unsupported: ['calendar placement', 'native phone and desktop controls'],
  })
}
