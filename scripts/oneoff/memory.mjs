import assert from 'node:assert/strict'
import { Effect, Schema } from 'effect'
import {
  ConversationState,
  RuntimeAdmissionReceipt,
  RuntimeSettlement,
} from '../../packages/contracts/src/index.ts'

const decodeReceipt = Schema.decodeUnknownEffect(RuntimeAdmissionReceipt)
const decodeSettlement = Schema.decodeUnknownEffect(RuntimeSettlement)
const decodeState = Schema.decodeUnknownEffect(ConversationState)

/** Ask the real model in each imported Person cell; only persisted search tool output proves recall. */
export async function proveMemory(state, notes, bearer, json) {
  const results = []
  for (const [personId, entries] of notes) {
    const terms = entries.map((note) => {
      const word = note.body.match(/[A-Za-z]{5,}/u)
      assert.ok(word, 'Imported note needs a searchable word')
      return word[0]
    })
    const query = terms.length === 0 ? 'migration' : [...new Set(terms)].join(' OR ')
    const threadId = crypto.randomUUID()
    const address = `http://127.0.0.1:${state.ports.runtime}/persons/${personId}/threads/${threadId}`
    const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }
    const response = await fetch(address, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        threadId,
        idempotencyKey: crypto.randomUUID(),
        type: 'message',
        body: `Please call search_memory with query ${JSON.stringify(query)} and limit 10, across all layers. Report the matching descriptions. This is a read-only check. Do not write or delete memory.`,
        attributes: {},
        attachments: [],
        turn: 1,
        scope: { acting: personId },
        initialData: { creator: personId, creatorName: 'Migration verification fixture' },
      }),
    })
    assert.equal(response.status, 202)
    const admitted = await Effect.runPromise(decodeReceipt(await response.json()))
    const ended = await fetch(`${address}/submissions/${admitted.submissionId}`, { headers })
    assert.equal(ended.status, 200)
    const settlement = await Effect.runPromise(decodeSettlement(await ended.json()))
    await json(`memory-${personId}-settlement`, settlement)
    assert.ok(RuntimeSettlement.guards.Done(settlement), 'Memory check did not complete')
    const current = await fetch(`${address}/state`, { headers })
    assert.equal(current.status, 200)
    const page = await Effect.runPromise(decodeState(await current.json()))
    await json(`memory-${personId}-history`, page)
    const calls = page.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'dynamic-tool')
    assert.equal(
      calls.filter((call) => call.toolName === 'write_memory' || call.toolName === 'delete_memory')
        .length,
      0,
    )
    const searches = calls.filter(
      (call) => call.toolName === 'search_memory' && call.state === 'output-available',
    )
    assert.ok(searches.length > 0, 'No successful search_memory receipt')
    const hits = searches.flatMap((call) => call.output.entries)
    for (const note of entries) {
      const hit = hits.find((hit) => hit.file === note.file && hit.layer === note.layer)
      assert.ok(hit, 'Imported entry not returned by search_memory')
      assert.equal(hit.basis, 'said')
      assert.equal(hit.updatedAt, note.updatedAt)
      assert.equal(hit.revision, 1)
    }
    if (entries.length === 0) assert.equal(hits.length, 0)
    results.push({
      personId,
      importedNotes: entries.length,
      searchCalls: searches.length,
      returnedNotes: hits.length,
    })
  }
  return results
}
