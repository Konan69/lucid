import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { connectPulse } from './watch.mjs'
import { providerSnapshot } from './snapshot.mjs'
import { chat, settled, history, rpc, json } from './wire.mjs'

/** A Person's Ask rule makes the real disposable Integration mutation require a decision. */
async function decide(state, id, directory, { browser, allow }) {
  assert.equal(state.modelKind, 'real')
  const integration = await connectPulse(state, directory)
  let rule
  try {
    rule = (
      await rpc(
        state,
        'CreateRule',
        {
          action: 'Produce a verification pulse with Verify Pulse',
          decision: 'Ask',
          scope: { _tag: 'Personal' },
        },
        directory,
      )
    ).rule
    const receipt = crypto.randomUUID()
    const prompt = `Using my Verify Pulse Integration, produce one pulse with receipt ${receipt} and words approval-verification. Discover its emit operation with find_tools, then call it directly with use_tool. My Ask rule requires a decision before it runs. Do not use run_code or create a Watch. If I deny it, do not try another route.`
    if (browser) {
      await browser.run(['find', 'label', 'Message Vivid', 'fill', prompt])
      await browser.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    } else await chat(state, id, prompt, directory)
    const proposed = await settled(state, id, 1, 'Completed', directory)
    assert.equal(proposed.approvals.length, 1, 'Model must propose one real Integration action')
    const approval = proposed.approvals[0]
    assert.equal(approval.state._tag, 'Pending')
    assert.equal(approval.action.target._tag, 'Connection')
    assert.equal(approval.action.target.connectionId, integration.connection.id)
    assert.equal(approval.action.target.input.receipt, receipt)
    await json(directory + '/pending.json', approval)
    const snapshot = async (stage) => {
      const evidence = directory + '/' + stage
      await fs.mkdir(evidence, { recursive: true })
      return providerSnapshot(
        state,
        { callback: state.web + '/unused-approval-callback', receipt },
        evidence,
      )
    }
    assert.equal(
      (await snapshot('before')).events.length,
      0,
      'Action ran before the Person decided',
    )
    const decision = {
      id: approval.id,
      digest: approval.digest,
      decision: { _tag: allow ? 'AllowOnce' : 'Deny' },
    }
    if (browser) {
      await browser.run(['wait', 'section[aria-label="Vivid asks first"]'])
      await browser.capture('pending')
      await browser.run([
        'find',
        'role',
        'button',
        'click',
        '--name',
        allow ? 'Allow' : 'Don’t allow',
        '--exact',
      ])
    } else await rpc(state, 'DecideApproval', decision, directory)
    const done = await settled(state, id, 2, 'Completed', directory)
    assert.equal(done.runs.length, 2)
    assert.equal(done.runs[1].origin._tag, 'Decision')
    const outcome = done.approvals.find((candidate) => candidate.id === approval.id)
    assert.equal(outcome.state._tag, allow ? 'Succeeded' : 'Denied')
    const repeated = await rpc(state, 'DecideApproval', decision, directory, 'repeated-decision')
    assert.equal(repeated.approval.state._tag, outcome.state._tag)
    const external = await snapshot('after')
    assert.equal(external.events.length, allow ? 1 : 0)
    await history(state, id, directory)
    if (browser) {
      for (const stage of ['decided', 'reloaded']) {
        if (stage === 'reloaded') await browser.run(['reload'])
        await browser.run(['wait', '[aria-label="Message Vivid"]'])
        await browser.run([
          'wait',
          '--fn',
          `!document.querySelector('section[aria-label="Vivid asks first"]')`,
        ])
        await browser.capture(stage)
      }
    }
    await json(directory + '/proof.json', { approval: outcome, successor: done.runs[1], external })
  } finally {
    if (rule) await rpc(state, 'DeleteRule', { id: rule.id }, directory)
    await rpc(state, 'RemoveConnection', { id: integration.connection.id }, directory)
  }
}

/** Allow the saved digest-bound mutation and observe its single disposable provider event. */
export const approve = (state, id, directory, browser) =>
  decide(state, id, directory, { browser, allow: true })

/** Denial must settle without producing the proposed provider event. */
export const deny = (state, id, directory, browser) =>
  decide(state, id, directory, { browser, allow: false })
