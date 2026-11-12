import * as NodeAssert from 'node:assert/strict'
import { Channel } from '@vivid/contracts'
import { Result, Schema } from 'effect'
import { json, rpc } from './wire.mjs'
import { catalog, settingsLimits } from './settingsproof.mjs'

const Groups = Schema.Array(
  Schema.Struct({ purpose: Schema.String, names: Schema.Array(Schema.String) }),
)
const BrowserGroups = Schema.Union([Groups, Schema.fromJsonString(Groups)])
const Navigation = Schema.Array(Schema.Struct({ tag: Schema.String, text: Schema.String }))
const BrowserNavigation = Schema.Union([Navigation, Schema.fromJsonString(Navigation)])
const decodeGroups = Schema.decodeUnknownResult(Schema.fromJsonString(BrowserGroups))
const decodeNavigation = Schema.decodeUnknownResult(Schema.fromJsonString(BrowserNavigation))
const decodeText = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.String))

/** Read only the open dialog's semantic groups. Hidden source and background Home cannot satisfy them. */
async function groups(run) {
  const expression = `Array.from(document.querySelectorAll('[role="dialog"] section')).filter(section => section.querySelector('h3') && section.querySelector('h3').innerText.trim() !== 'Connected' && section.querySelector('ul')).map(section => ({ purpose: section.querySelector('h3').innerText.trim(), names: Array.from(section.querySelectorAll('ul > li')).map(li => li.innerText.split('\\n')[0].trim()) }))`
  return Result.getOrThrow(decodeGroups(await run(['eval', 'JSON.stringify(' + expression + ')'])))
}

/** Text Vivid precedes the catalog and filters the closed channel vocabulary by name. Both
 * sources must appear exactly once, retaining their own source order within each visible group. */
function assertCatalog(actual, services, query) {
  const channels = Channel.literals.filter((name) =>
    name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  )
  const expected = [...channels, ...services.map((service) => service.name)]
  NodeAssert.deepEqual(actual.flatMap((group) => group.names).toSorted(), expected.toSorted())
  NodeAssert.deepEqual(
    actual.filter((group) => group.purpose === 'Text Vivid'),
    channels.length === 0 ? [] : [{ purpose: 'Text Vivid', names: channels }],
  )
  for (const group of actual)
    NodeAssert.deepEqual(
      group.names,
      expected.filter((name) => group.names.includes(name)),
    )
}

/** The sentence the Memory section shows while the Person's cell remembers nothing listed. */
const EMPTY_MEMORY = 'When you tell Vivid something that matters later, it shows up here.'

/** Earlier model journeys may have taught this Person. Compare Settings with its actual index,
 * rather than requiring an unused account after the full-product run has already exchanged words. */
async function memory(state, context, browser) {
  const { id, directory } = context
  const { run, capture } = browser
  const index = await rpc(state, 'GetMemoryIndex', undefined, directory, 'memory-index')
  const expected =
    index.lines.length === 0 ? [EMPTY_MEMORY] : index.lines.map((line) => line.description)
  await run(['open', state.web + '/t/' + id + '?settings=memory'])
  const section = `Array.from(document.querySelectorAll('[role="dialog"] section')).find(section => section.querySelector('h3')?.innerText.trim() === 'What Vivid remembers')`
  for (const stage of ['memory', 'memory-reloaded']) {
    await run([
      'wait',
      '--fn',
      `Boolean(${section}) && ${JSON.stringify(expected)}.every(words => ${section}.innerText.includes(words))`,
    ])
    const headings = Result.getOrThrow(
      decodeText(
        await run([
          'eval',
          `JSON.stringify(Array.from(document.querySelectorAll('[role="dialog"] h3')).map(node => node.innerText).join(' '))`,
        ]),
      ),
    )
    NodeAssert.ok(!/saved knowledge|\bnotes?\b/iu.test(headings), 'Obsolete Memory section heading')
    await capture(stage)
    if (stage === 'memory') await run(['reload'])
  }
}

/** Drive the actual Settings tabs and catalog search, without starting any external authorization. */
export async function settingsBrowser(state, id, directory, browser) {
  const { run, capture } = browser
  const before = await rpc(state, 'ListConnections', undefined, directory, 'before-browsing')
  await memory(state, { id, directory }, browser)
  const navigation = Result.getOrThrow(
    decodeNavigation(
      await run([
        'eval',
        `JSON.stringify(Array.from(document.querySelector('[role="dialog"] nav').children).map(node => ({ tag: node.tagName, text: node.innerText.trim() })))`,
      ]),
    ),
  )
  NodeAssert.deepEqual(navigation, [
    { tag: 'P', text: 'You' },
    ...['General', 'What Vivid knows', 'What Vivid is doing', 'Text Vivid', 'Devices'].map(
      (text) => ({
        tag: 'BUTTON',
        text,
      }),
    ),
    { tag: 'P', text: 'Your space' },
    ...['People', 'Integrations', 'Rules', 'Record'].map((text) => ({ tag: 'BUTTON', text })),
  ])
  await json(directory + '/settings-navigation.json', navigation)
  await run(['find', 'role', 'button', 'click', '--name', 'Integrations', '--exact'])
  await run(['wait', '[aria-label="Search integrations"]'])
  await run([
    'wait',
    '--fn',
    `Array.from(document.querySelectorAll('[role="dialog"] h3')).some(h => h.innerText.trim() === 'Mail and calendar')`,
  ])
  // Channels arrive through their own live query, independently of FindServices.
  await run([
    'wait',
    '--fn',
    `Array.from(document.querySelectorAll('[role="dialog"] h3')).some(h => h.innerText.trim() === 'Text Vivid')`,
  ])
  const popular = await catalog(state, directory, '', 'popular-services')
  const visible = await groups(run)
  assertCatalog(visible, popular, '')
  const order = [
    'Text Vivid',
    'Mail and calendar',
    'Files and notes',
    'Chat and meetings',
    'Work tools',
    'Design',
    'Sales and research',
    'Code and data',
    'More',
  ]
  NodeAssert.deepEqual(
    visible.map((group) => group.purpose),
    order.filter((purpose) => visible.some((group) => group.purpose === purpose)),
  )
  NodeAssert.ok(
    visible.some((group) => group.purpose === 'Mail and calendar' && group.names.includes('Gmail')),
  )
  NodeAssert.ok(
    visible.some(
      (group) => group.purpose === 'Files and notes' && group.names.includes('Google Drive'),
    ),
  )
  await json(directory + '/popular-groups.json', visible)
  await capture('purpose-groups')
  await run(['find', 'label', 'Search integrations', 'fill', 'Gmail'])
  const searched = await catalog(state, directory, 'Gmail', 'gmail-search')
  await run([
    'wait',
    '--fn',
    `Array.from(document.querySelectorAll('[role="dialog"] h3')).some(h => h.innerText.trim() === 'Results')`,
  ])
  // The app keeps the last answer while search resolves. Wait for its real tiles, not the heading alone.
  const names = searched.map((service) => service.name)
  await run([
    'wait',
    '--fn',
    `JSON.stringify(Array.from(document.querySelectorAll('[role="dialog"] section')).filter(s => s.querySelector('h3')?.innerText.trim() === 'Results').flatMap(s => Array.from(s.querySelectorAll('ul > li')).map(li => li.innerText.split('\\n')[0].trim()))) === ${JSON.stringify(JSON.stringify(names))}`,
  ])
  const results = await groups(run)
  NodeAssert.deepEqual(
    results.map((group) => group.purpose),
    ['Results'],
  )
  assertCatalog(results, searched, 'Gmail')
  await json(directory + '/search-groups.json', results)
  await capture('catalog-search')
  const connections = await rpc(state, 'ListConnections', undefined, directory, 'after-browsing')
  NodeAssert.deepEqual(connections.connections, before.connections, 'Browsing changed a connection')
  await json(directory + '/scope.json', {
    modelCalls: 0,
    blocked: settingsLimits,
    observedPurposes: visible.map((group) => group.purpose),
  })
  return {
    scope:
      'Personal Settings groups, the empty memory list before and after reload, popular Integration groups and Gmail search. See scope.json for unproved groups and native entry points.',
  }
}
