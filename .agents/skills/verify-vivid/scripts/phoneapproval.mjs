import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import { connectPulse } from './watch.mjs'
import { providerSnapshot } from './snapshot.mjs'
import { json, rpc, settled } from './wire.mjs'
import { RuleScope } from '@vivid/contracts'

/** The phone decision, not an HTTP substitute, releases or denies the real Ask-rule mutation. */
export async function approval(state, id, ui, allow) {
  const integration = await connectPulse(state, ui.directory)
  let rule
  try {
    rule = (
      await rpc(
        state,
        'CreateRule',
        {
          action: 'Produce a verification pulse with Verify Pulse',
          decision: 'Ask',
          scope: RuleScope.cases.Personal.make({}),
        },
        ui.directory,
      )
    ).rule
    const receipt = crypto.randomUUID()
    await ui.send(
      `Using my Verify Pulse Integration, produce one pulse with receipt ${receipt} and words approval-verification. Discover its emit operation with find_tools, then call it directly with use_tool. My Ask rule requires a decision before it runs. Do not use run_code or create a Watch. If I deny it, do not try another route.`,
    )
    const pending = await settled(state, id, 1, 'Completed', ui.directory)
    NodeAssert.equal(pending.approvals.length, 1, 'Model did not propose one Integration action')
    const action = pending.approvals[0]
    NodeAssert.equal(action.state._tag, 'Pending')
    NodeAssert.equal(action.action.target._tag, 'Connection')
    NodeAssert.equal(action.action.target.connectionId, integration.connection.id)
    NodeAssert.equal(action.action.target.input.receipt, receipt)
    const external = async (stage) => {
      const directory = ui.directory + '/' + stage
      await NodeFSP.mkdir(directory, { recursive: true })
      return providerSnapshot(
        state,
        { callback: state.web + '/unused-approval-callback', receipt },
        directory,
      )
    }
    NodeAssert.equal(
      (await external('before')).events.length,
      0,
      'Mutation ran before a phone decision',
    )
    await ui.visible(allow ? 'Allow' : 'Don’t allow')
    await ui.capture('pending')
    await ui.press(allow ? 'Allow' : 'Don’t allow')
    const done = await ui.completed(id, 2, 'decided')
    const outcome = done.detail.approvals.find((entry) => entry.id === action.id)
    NodeAssert.equal(outcome.state._tag, allow ? 'Succeeded' : 'Denied')
    NodeAssert.equal(done.detail.runs[1].origin._tag, 'Decision')
    const provider = await external('after')
    NodeAssert.equal(provider.events.length, allow ? 1 : 0)
    await json(ui.directory + '/proof.json', { outcome, provider, successor: done.detail.runs[1] })
    await ui.capture('decided')
    await ui.create('Decision away ' + crypto.randomUUID().slice(0, 8))
    await ui.visit(id)
    await ui.run(['wait', 'absent', 'label="Allow"', '60000'])
    await ui.capture('decision-reopened')
  } finally {
    if (rule) await rpc(state, 'DeleteRule', { id: rule.id }, ui.directory)
    await rpc(state, 'RemoveConnection', { id: integration.connection.id }, ui.directory)
  }
}
