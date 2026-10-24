import * as NodeAssert from 'node:assert/strict'
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
  const expression = `Array.from(document.querySelectorAll('[role="dialog"] section')).filter(section => section.querySelector('h3') && section.querySelector('ul')).map(section => ({ purpose: section.querySelector('h3').innerText.trim(), names: Array.from(section.querySelectorAll('ul > li')).map(li => li.innerText.split('\\n')[0].trim()) }))`
  return Result.getOrThrow(decodeGroups(await run(['eval', 'JSON.stringify(' + expression + ')'])))
}

/** Each public service appears exactly once, retaining the public catalog order within its visible group. */
function assertCatalog(actual, services) {
  const expected = services.map((service) => service.name)
  NodeAssert.deepEqual(actual.flatMap((group) => group.names).toSorted(), expected.toSorted())
  for (const group of actual)
    NodeAssert.deepEqual(
      group.names,
      expected.filter((name) => group.names.includes(name)),
    )
}

/** The empty knowledge copy distinguishes searchable facts from Vivid's own notes, including after reload. */
async function memory(state, context, browser) {
  const { id, directory } = context
  const { run, capture } = browser
  const knowledge = await rpc(state, 'ListMemory', undefined, directory, 'empty-knowledge')
  NodeAssert.deepEqual(knowledge.memories, [], 'Recipe needs an unused disposable knowledge base')
  NodeAssert.equal(knowledge.brief.text.trim(), '')
  await run(['open', state.web + '/t/' + id + '?settings=memory'])
  for (const stage of ['knowledge', 'knowledge-reloaded']) {
    await run([
      'wait',
      '--fn',
      `Boolean(document.querySelector('[role="dialog"]')?.innerText.includes('Nothing saved yet.'))`,
    ])
    const value = Result.getOrThrow(
      decodeText(
        await run(['eval', `JSON.stringify(document.querySelector('[role="dialog"]').innerText)`]),
      ),
    )
    for (const words of [
      'A summary of the saved knowledge below.',
      'Nothing yet. Facts Vivid saves for reference are summed up here.',
      'Facts Vivid can look up. Correct what is wrong, or remove what it should not keep.',
      'Vivid’s own notes are not shown here.',
    ])
      NodeAssert.ok(value.includes(words), 'Missing visible knowledge wording ' + words)
    await capture(stage)
    if (stage === 'knowledge') await run(['reload'])
  }
}

/** Drive the actual Settings tabs and catalog search, without starting any external authorization. */
export async function settingsBrowser(state, id, directory, browser) {
  const { run, capture } = browser
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
    ...['General', 'What Vivid knows', 'Text Vivid', 'Devices'].map((text) => ({
      tag: 'BUTTON',
      text,
    })),
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
  const popular = await catalog(state, directory, '', 'popular-services')
  const visible = await groups(run)
  assertCatalog(visible, popular)
  const order = [
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
  assertCatalog(results, searched)
  await json(directory + '/search-groups.json', results)
  await capture('catalog-search')
  const connections = await rpc(state, 'ListConnections', undefined, directory, 'after-browsing')
  NodeAssert.deepEqual(connections.connections, [], 'Browsing started an external connection')
  await json(directory + '/scope.json', {
    modelCalls: 0,
    blocked: settingsLimits,
    observedPurposes: visible.map((group) => group.purpose),
  })
  return {
    scope:
      'Personal Settings groups, empty saved knowledge before and after reload, popular Integration groups and Gmail search. See scope.json for unproved groups and native entry points.',
  }
}
