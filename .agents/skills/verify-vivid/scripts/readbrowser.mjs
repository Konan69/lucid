import * as NodeAssert from 'node:assert/strict'
import { json, rpc } from './wire.mjs'
import { readLimits } from './reading.mjs'
import { readTraffic } from './readtraffic.mjs'

/** Count only the browser's public read requests, never HTTP setup calls. */
const reports = (events, id) =>
  events.filter((e) => e.kind === 'request' && e.tag === 'MarkThreadRead' && e.thread === id).length
const receipts = (events, id) =>
  events.filter((e) => e.kind === 'receipt' && e.thread === id && e.outcome === 'Success').length

/** The sidebar renders every row in a clipped scrolling nav. Reveal the real row before clicking
 * its link, preserving the application and ledger and excluding inert copies left by list motion. */
async function visit(run, id) {
  const selector = 'aside nav [data-moves="' + id + '"] a[href="/t/' + id + '"]'
  await run(['wait', selector])
  await run(['scrollintoview', selector])
  await run(['click', selector])
  await run(['wait', '--url', '**/t/' + id])
  await run(['wait', '[aria-label="Message Vivid"]'])
}

/** Fifty remembered standings suppress repeats. The fifty-first evicts the oldest in one web session. */
export async function readBrowser(state, id, directory, browser) {
  const { run, capture } = browser
  const threads = []
  for (let index = 0; index < 51; index++) {
    const next = crypto.randomUUID()
    await rpc(
      state,
      'CreateThread',
      {
        id: next,
        title: 'Read ledger ' + String(index + 2).padStart(2, '0'),
        projectId: null,
      },
      directory,
      'create-' + index,
    )
    threads.push(next)
  }
  await json(directory + '/threads.json', [id, ...threads])
  const observed = await readTraffic(run, state.web + '/t/' + id)
  try {
    // Start observation before the new socket, then use only actual sidebar navigation.
    await run(['reload'])
    await observed.wait((events) => receipts(events, id) === 1)
    for (const next of threads.slice(0, 49)) {
      await visit(run, next)
      await observed.wait((events) => receipts(events, next) === 1)
    }
    await visit(run, threads[47])
    await visit(run, threads[48])
    await observed.painted()
    NodeAssert.equal(reports(observed.events, threads[47]), 1, 'Remembered Thread reported twice')
    NodeAssert.equal(reports(observed.events, threads[48]), 1, 'Remembered Thread reported twice')
    await capture('fifty-remembered')
    await visit(run, threads[49])
    await observed.wait((events) => receipts(events, threads[49]) === 1)
    await visit(run, id)
    await observed.wait((events) => receipts(events, id) === 2)
    NodeAssert.equal(
      reports(observed.events, id),
      2,
      'Oldest Thread was not reported after eviction',
    )
    await capture('oldest-revisited')
    await background(state, { id, next: threads[50], directory }, browser, observed)
    return {
      scope:
        'One web session, 52 empty Threads, repeat suppression, eviction after 50 remembered standings, offscreen update and report on return. See scope.json for blocked subcases.',
    }
  } finally {
    await json(directory + '/rpc-traffic.json', observed.events)
    await json(directory + '/scope.json', { modelCalls: 0, blocked: readLimits })
    observed.close()
  }
}

/** Wait for a real offscreen WatchThread publication before checking that it caused no read write. */
async function background(state, context, browser, observed) {
  const { id, next, directory } = context
  const { run, capture } = browser
  await visit(run, next)
  await observed.wait((events) => receipts(events, next) === 1)
  const before = reports(observed.events, id)
  const changed = await rpc(
    state,
    'PatchThread',
    {
      id,
      patch: { title: 'Read ledger background update' },
    },
    directory,
    'background-patch',
  )
  await observed.wait((events) =>
    events.some(
      (event) =>
        event.kind === 'standing' &&
        event.thread === id &&
        event.moved === changed.thread.updatedAt,
    ),
  )
  await run(['wait', '--text', changed.thread.title])
  await observed.painted()
  NodeAssert.equal(reports(observed.events, id), before, 'Offscreen publication marked Thread read')
  await capture('background-remains-unseen')
  await visit(run, id)
  await observed.wait((events) => receipts(events, id) === before + 1)
  NodeAssert.equal(
    reports(observed.events, id),
    before + 1,
    'Changed standing was not read on return',
  )
  await capture('background-opened')
}
