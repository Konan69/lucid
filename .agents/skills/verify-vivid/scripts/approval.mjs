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

/**
 * A Person edits what Vivid asked to send, after it asked. The ask carries the document's text as
 * it was (a `{"$document": title}` reference resolved by the server), so the edit makes it stale:
 * Allow on it is refused with ApprovalChanged and nothing reaches the provider. Vivid is woken by
 * the stale outcome and asks again from the edited text; allowing that fresh ask sends once.
 *
 * The edit goes through the public ReviseArtifact RPC with the Person's own session, because no
 * client has a document editor yet (`ReviseArtifact` has no caller in apps/web or apps/mobile).
 */
export async function changed(state, id, directory, browser) {
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
    const title = 'Pulse words ' + receipt.slice(0, 8)
    const first = 'first-version-' + receipt.slice(0, 8)
    const second = 'second-version-' + receipt.slice(0, 8)
    const prompt = `Write a document titled ${title} whose whole text is ${first}. Then, using my Verify Pulse Integration, produce one pulse with receipt ${receipt} whose words are that document: discover its emit operation with find_tools, then call use_tool with input {"receipt": "${receipt}", "words": {"$document": "${title}"}}. My Ask rule requires a decision before it runs. Do not use run_code or create a Watch.`
    if (browser) {
      await browser.run(['find', 'label', 'Message Vivid', 'fill', prompt])
      await browser.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    } else await chat(state, id, prompt, directory)
    const asked = await settled(state, id, 1, 'Completed', directory)
    assert.equal(asked.approvals.length, 1, 'Model must propose one real Integration action')
    const old = asked.approvals[0]
    assert.equal(old.state._tag, 'Pending')
    assert.equal(old.action.target.connectionId, integration.connection.id)
    assert.equal(old.action.target.input.words, first, 'The ask must carry the document text')
    assert.equal(old.binding.preconditions.length, 1)
    assert.equal(old.binding.preconditions[0].version, 1)
    await json(directory + '/asked.json', old)
    if (browser) {
      await browser.run(['wait', 'section[aria-label="Vivid asks first"]'])
      await browser.capture('asked')
    }
    const documents = (await rpc(state, 'ListArtifacts', { threadId: id }, directory)).artifacts
    const letter = documents.find((document) => document.title === title)
    assert.ok(letter, 'Vivid must have written the document it sends')
    await rpc(state, 'ReviseArtifact', { id: letter.id, from: 1, body: second }, directory)
    const refusal = await rpc(
      state,
      'DecideApproval',
      { id: old.id, digest: old.digest, decision: { _tag: 'AllowOnce' } },
      directory,
      'allow-stale',
    ).then(
      () => assert.fail('Allow on the stale ask must be refused'),
      (error) => error.message,
    )
    assert.match(refusal, /"_tag":"ApprovalChanged"/)
    const snapshot = async (stage) => {
      const evidence = directory + '/' + stage
      await fs.mkdir(evidence, { recursive: true })
      return providerSnapshot(
        state,
        { callback: state.web + '/unused-approval-callback', receipt },
        evidence,
      )
    }
    assert.equal((await snapshot('refused')).events.length, 0, 'The stale ask reached the provider')
    // The stale outcome wakes Vivid (approval sweeper, every 30 s), which asks again.
    const again = await settled(state, id, 2, 'Completed', directory)
    const stale = again.approvals.find((candidate) => candidate.id === old.id)
    assert.equal(stale.state._tag, 'Invalidated')
    assert.equal(stale.state.reason._tag, 'ContentChanged')
    assert.equal(stale.state.reason.version, 2)
    const fresh = again.approvals.find((candidate) => candidate.state._tag === 'Pending')
    assert.ok(fresh, 'Vivid must ask again after the edit')
    assert.notEqual(fresh.id, old.id)
    assert.equal(fresh.action.target.input.words, second, 'The fresh ask must carry the edit')
    await json(directory + '/fresh.json', fresh)
    if (browser) {
      await browser.run(['wait', '--text', 'The document changed after this was asked.'])
      await browser.run(['wait', 'section[aria-label="Vivid asks first"]'])
      await browser.capture('asked-again')
      await browser.run(['find', 'role', 'button', 'click', '--name', 'Allow', '--exact'])
    } else
      await rpc(state, 'DecideApproval', {
        id: fresh.id,
        digest: fresh.digest,
        decision: { _tag: 'AllowOnce' },
      })
    const done = await settled(state, id, 3, 'Completed', directory)
    const sent = done.approvals.find((candidate) => candidate.id === fresh.id)
    assert.equal(sent.state._tag, 'Succeeded')
    const external = await snapshot('after')
    assert.equal(external.events.length, 1, 'Exactly the fresh ask reached the provider')
    await history(state, id, directory)
    if (browser) {
      await browser.run(['reload'])
      await browser.run(['wait', '[aria-label="Message Vivid"]'])
      await browser.run(['wait', '--text', 'The document changed after this was asked.'])
      await browser.capture('reloaded')
    }
    await json(directory + '/proof.json', { stale, fresh: sent, external })
  } finally {
    if (rule) await rpc(state, 'DeleteRule', { id: rule.id }, directory)
    await rpc(state, 'RemoveConnection', { id: integration.connection.id }, directory)
  }
}
