import * as NodeAssert from 'node:assert/strict'
import * as NodeFSP from 'node:fs/promises'
import { chat, history, json, settled } from './wire.mjs'

/** Public responses are retained before the model runs so a changed site cannot masquerade as the repro. */
export async function pageAddress(directory) {
  for (const [index, address] of [
    'https://www.notion.so/settings/mcp',
    'https://app.notion.com/notion-mcp',
  ].entries()) {
    const response = await fetch(address, { signal: AbortSignal.timeout(30_000) })
    const body = await response.text()
    await NodeFSP.writeFile(directory + '/notion-' + index + '.html', body)
    await json(directory + '/notion-' + index + '.json', {
      address,
      status: response.status,
      final: response.url,
    })
    if (
      /JavaScript must be enabled in order to use Notion|You need to enable JavaScript to run this app/u.test(
        body,
      )
    )
      return address
  }
  return null
}

/** A script-only response must lead to a real browser or a plain admission that it could not be read. */
export async function pages(state, id, directory, browser) {
  NodeAssert.equal(state.modelKind, 'real', 'Page reading needs a real model')
  const address = await pageAddress(directory)
  NodeAssert.ok(address, 'blocked: neither Notion address currently serves the JavaScript notice')
  for (const [index, url] of [address, 'https://example.com/'].entries()) {
    const prompt = `Read ${url} and tell me what the page says.`
    if (browser) {
      await browser.run(['find', 'label', 'Message Vivid', 'fill', prompt])
      await browser.run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    } else await chat(state, id, prompt, directory, 'read-' + index)
    await settled(state, id, index + 1, 'Completed', directory)
    const page = await history(state, id, directory, 'history-' + index)
    const reply = page.messages.findLast((message) => message.role === 'assistant')
    NodeAssert.ok(reply, 'Missing page reply')
    const words = reply.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
    const calls = page.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'dynamic-tool' && part.state === 'output-available')
    const read = calls.findLast(
      (part) => part.toolName === 'read_page' && part.input.address === url,
    )
    await json(directory + '/reply-' + index + '.json', { url, words })
    if (index === 0) {
      NodeAssert.ok(
        read &&
          read.output.ok === false &&
          read.output.reason === 'needs a browser to show its content',
        'Missing the actual script-only refusal receipt',
      )
      const opened = calls.some(
        (part) =>
          part.toolName === 'browse' &&
          part.input.action &&
          part.input.action.address === url &&
          part.output.ok === true,
      )
      const limited =
        /(?:couldn.t|cannot|can.t|unable|could not).{0,100}(?:read|access|open|load)|needs? (?:a |the )?(?:real )?browser/isu.test(
          words,
        )
      NodeAssert.ok(
        opened || limited,
        'Vivid neither opened the requested page nor plainly said it could not read it',
      )
      NodeAssert.doesNotMatch(
        words,
        /(?:page (?:says|contains)|content is).{0,40}JavaScript must/isu,
        'Script notice presented as page content',
      )
    } else {
      NodeAssert.ok(
        read && read.output.ok === true,
        'Missing the actual ordinary-page read receipt',
      )
      NodeAssert.match(
        words,
        /example domain|documentation examples/iu,
        'Ordinary page was not read',
      )
    }
    if (browser) {
      await browser.run([
        'wait',
        '--fn',
        `document.body.innerText.includes(${JSON.stringify(index === 0 ? 'Notion' : 'Example')})`,
      ])
      await browser.capture('page-' + index)
    }
    await json(directory + '/step-' + index + '.json', { verdict: 'proved', url, words })
  }
}
