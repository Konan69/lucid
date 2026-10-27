import * as assert from 'node:assert/strict'
import { chat, settled, history, rpc, json } from './wire.mjs'

const prompt =
  'Before writing a one-sentence garden plan, ask me to choose its name using a question card. Offer exactly Cedar and Willow as alternatives, with one choice allowed. Do not choose for me. After I answer, write the plan with my chosen name.'

/** The real model must raise a durable question; plain prose cannot satisfy this journey. */
export async function question(state, id, directory, browser) {
  assert.equal(state.modelKind, 'real')
  if (browser) {
    await browser.run(['find', 'label', 'Message Vivid', 'fill', prompt])
    await browser.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
  } else await chat(state, id, prompt, directory)
  const asked = await settled(state, id, 1, 'Completed', directory)
  assert.equal(asked.requests.length, 1, 'Expected a model-generated question card')
  const request = asked.requests[0]
  assert.equal(request.state._tag, 'Waiting')
  assert.equal(request.questions.length, 1)
  assert.equal(request.questions[0].selection, 'One')
  const labels = request.questions[0].options.map((option) => option.label)
  assert.deepEqual([...labels].sort(), ['Cedar', 'Willow'])
  const answers = [{ _tag: 'Chosen', labels: ['Cedar'] }]
  await json(directory + '/question.json', { request, answers })
  if (browser) {
    await browser.run(['wait', 'section[aria-label="Vivid\'s question"]'])
    await browser.capture('waiting')
    await browser.run(['find', 'text', 'Cedar', 'click', '--exact'])
  } else {
    const response = await rpc(state, 'AnswerInput', { id: request.id, answers }, directory)
    assert.equal(response.request.state._tag, 'Answered')
    assert.deepEqual(response.request.state.answers, answers)
  }
  const done = await settled(state, id, 2, 'Completed', directory)
  assert.equal(done.runs.length, 2)
  assert.equal(done.runs[1].origin._tag, 'Decision')
  const answered = done.requests.find((candidate) => candidate.id === request.id)
  assert.equal(answered.state._tag, 'Answered')
  assert.deepEqual(answered.state.answers, answers)
  const page = await history(state, id, directory)
  const reply = page.messages
    .filter(
      (message) =>
        message.purpose === 'assistant' && message.submissionId === done.runs[1].submissionId,
    )
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
  assert.match(reply, /Cedar/u, 'The continuation did not use the chosen answer')
  if (browser) {
    for (const stage of ['answered', 'reloaded']) {
      if (stage === 'reloaded') await browser.run(['reload'])
      await browser.exactReply(reply, stage)
      await browser.run([
        'wait',
        '--fn',
        `!Array.from(document.querySelectorAll('section')).some(element => element.getAttribute('aria-label') === "Vivid's question")`,
      ])
      await browser.capture(stage)
    }
    const reloaded = await history(state, id, directory, 'reloaded-history')
    assert.deepEqual(
      reloaded.messages.map(({ id, parts }) => ({ id, parts })),
      page.messages.map(({ id, parts }) => ({ id, parts })),
    )
  }
  await json(directory + '/proof.json', {
    request: request.id,
    answers,
    successor: done.runs[1],
    reply,
  })
}
