import * as NodeAssert from 'node:assert/strict'
import { json, rpc } from './wire.mjs'
import {
  libraryFile,
  libraryReady,
  libraryContent,
  libraryReply,
  removeLibraryFile,
} from './library.mjs'

/** Read the actual original-file link, open its new tab and compare the visible original text. */
async function original(state, { fixture, document, directory }, browser) {
  const { run, capture } = browser
  const link = '[aria-label="Open the original file"]'
  const href = (await run(['get', 'attr', link, 'href'])).trim()
  NodeAssert.equal(href, '/api/library/' + document.id + '/content')
  await run(['find', 'role', 'link', 'click', '--name', 'Open the original file', '--exact'])
  await run(['tab', 't2'])
  await run(['wait', '--url', '**' + href])
  await run(['wait', '--text', fixture.answer])
  const text = (await run(['get', 'text', 'body'])).trim()
  NodeAssert.equal(text, fixture.text.trim(), 'Original tab differs from uploaded bytes')
  await json(directory + '/original-tab.json', { url: (await run(['get', 'url'])).trim(), text })
  await capture('original-tab')
  await run(['tab', 'close', 't2'])
  await run(['tab', 't1'])
  await libraryContent(state, { fixture, document, directory })
}

/** Upload uses the file input; search uses the form. Public reads observe, never seed, the result. */
async function ingest(state, context, browser) {
  const { fixture, directory } = context
  const { run, capture } = browser
  await run(['open', state.web + '/library'])
  await run(['wait', 'header input[aria-label="Upload files"]'])
  await capture('before-upload')
  await run(['upload', 'header input[aria-label="Upload files"]', fixture.file])
  const document = await libraryReady(state, fixture, directory)
  await run(['find', 'text', fixture.name, 'click', '--exact'])
  await run(['wait', '[aria-label="Open the original file"]'])
  await run(['wait', '--text', 'Ready'])
  await run(['wait', '--text', fixture.answer])
  await capture('ready')
  await original(state, { fixture, document, directory }, browser)
  await run(['find', 'role', 'button', 'click', '--name', 'Back', '--exact'])
  await run(['find', 'role', 'button', 'click', '--name', 'Search the Library', '--exact'])
  await run(['find', 'label', 'Search', 'fill', fixture.project, '--exact'])
  await run(['press', 'Enter'])
  await run(['wait', '--text', 'Search results'])
  await run(['wait', '--text', fixture.answer])
  await capture('search-result')
  await run(['reload'])
  await run(['find', 'text', fixture.name, 'click', '--exact'])
  await run(['wait', '[aria-label="Open the original file"]'])
  await run(['wait', '--text', fixture.answer])
  await capture('library-reloaded')
  const reloaded = await rpc(
    state,
    'GetLibraryItem',
    { id: document.id },
    directory,
    'reloaded-item',
  )
  NodeAssert.deepEqual(reloaded.document, document)
}

/** Markdown turns a Library citation into a source link; answer and link must share one bubble. */
async function cited(browser, fixture, directory, stage) {
  const source = '/api/library/source?name=' + encodeURIComponent(fixture.name)
  const bubble = `[data-vivid-bubble]:has(a[href="${source}"])`
  await browser.run([
    'wait',
    '--fn',
    `Array.from(document.querySelectorAll(${JSON.stringify(bubble)})).filter(bubble => bubble.innerText.includes(${JSON.stringify(fixture.answer)})).length === 1`,
  ])
  const text = (await browser.run(['get', 'text', bubble])).trim()
  await json(directory + '/' + stage + '-bubble.json', { text, source })
  return text
}

/** The real composer asks a question whose answer only the uploaded file contains. */
export async function libraryBrowser(state, id, directory, browser) {
  NodeAssert.equal(state.modelKind, 'real', 'Library requires a real model')
  const fixture = await libraryFile(directory)
  try {
    await ingest(state, { fixture, directory }, browser)
    const { run, capture } = browser
    await run(['open', state.web + '/t/' + id])
    await run(['wait', '[aria-label="Message Vivid"]'])
    await run(['find', 'label', 'Message Vivid', 'fill', fixture.prompt])
    await run(['find', 'role', 'button', 'click', '--name', 'Send', '--exact'])
    await libraryReply(state, id, fixture, directory)
    const text = await cited(browser, fixture, directory, 'cited')
    await capture('cited')
    await run(['reload'])
    await run(['wait', '[aria-label="Message Vivid"]'])
    NodeAssert.equal(await cited(browser, fixture, directory, 'cited-reloaded'), text)
    await capture('cited-reloaded')
  } finally {
    await removeLibraryFile(state, fixture, directory)
  }
}
