import * as NodeAssert from 'node:assert/strict'
import { ConnectionState } from '@vivid/contracts'
import { chat, history, json, rpc, settled } from './wire.mjs'

export const deepwiki = 'https://mcp.deepwiki.com/mcp'

/** Address imports must retain their identity when the Person asks for another account. */
export async function addresses(state, id, directory, browser) {
  NodeAssert.equal(state.modelKind, 'real', 'Address journeys require a real model')
  const before = await rpc(state, 'ListConnections', undefined, directory, 'before')
  const owned = new Set(before.connections.map((connection) => connection.id))
  const prompts = [
    `Add ${deepwiki} as an Integration called DeepWiki. Check that it works by reading the documentation structure for facebook/react.`,
    'Add another account of my DeepWiki Integration. Check that the new account works by reading the documentation structure for facebook/react.',
    `Add ${deepwiki}/ as an Integration.`,
  ]
  let first
  let connected = []
  try {
    for (const [index, prompt] of prompts.entries()) {
      if (browser) {
        await browser.run(['open', state.web + '/t/' + id])
        await browser.run(['wait', '[aria-label="Message Vivid"]'])
        await browser.run(['find', 'label', 'Message Vivid', 'fill', prompt])
        await browser.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
      } else await chat(state, id, prompt, directory, 'message-' + index)
      await settled(state, id, index + 1, 'Completed', directory)
      const page = await history(state, id, directory, 'history-' + index)
      const reply = page.messages.findLast((message) => message.role === 'assistant')
      NodeAssert.ok(reply, 'Missing Vivid reply')
      const words = reply.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' ')
      await json(directory + '/reply-' + index + '.json', { prompt, words })
      NodeAssert.doesNotMatch(
        words,
        /nothing here is called|(?:open|go to|remove.+in).{0,30}settings/iu,
      )
      const list = await rpc(state, 'ListConnections', undefined, directory, 'accounts-' + index)
      const added = list.connections.filter((connection) => !owned.has(connection.id))
      NodeAssert.equal(added.length, index === 0 ? 1 : 2, 'Unexpected account count')
      NodeAssert.ok(
        added.every(
          (connection) =>
            connection.origin === 'Address' && ConnectionState.guards.Ready(connection.state),
        ),
      )
      if (index === 2)
        NodeAssert.deepEqual(
          added.map((connection) => connection.id),
          connected,
          'The slash changed the existing accounts',
        )
      connected = added.map((connection) => connection.id)
      if (index < 2) {
        const account = added.find((connection) => index === 0 || connection.id !== first)
        NodeAssert.ok(account, 'Missing the new account')
        const read = await rpc(
          state,
          'UseDisplayTool',
          {
            name: 'read_wiki_structure@' + account.account,
            input: { repoName: 'facebook/react' },
            kind: 'Query',
          },
          directory,
          'read-' + index,
        )
        NodeAssert.equal(
          read.outcome._tag,
          'Completed',
          'The new account did not read React documentation',
        )
        first = added[0].id
      } else
        NodeAssert.match(
          words,
          /already.{0,80}(?:connected|have|added|integration|account|linked)/isu,
          'Vivid did not acknowledge the existing Integration',
        )
      if (browser) await accountsShown(state, browser, { added, index })
      await json(directory + '/step-' + index + '.json', {
        verdict: 'proved',
        accounts: added.map((connection) => connection.id),
      })
    }
  } finally {
    const list = await rpc(state, 'ListConnections', undefined, directory, 'cleanup-accounts')
    for (const connection of list.connections.filter((entry) => !owned.has(entry.id)))
      await rpc(
        state,
        'RemoveConnection',
        { id: connection.id },
        directory,
        'remove-' + connection.id,
      )
  }
}

/** Settings must show the accounts the public list holds, after the conversational request. */
async function accountsShown(state, browser, { added, index }) {
  await browser.capture('reply-' + index)
  await browser.run(['open', state.web + '/?settings=connections'])
  for (const connection of added)
    await browser.run([
      'wait',
      '--fn',
      `document.body.innerText.includes(${JSON.stringify(connection.account)})`,
    ])
  await browser.capture('accounts-' + index)
}
