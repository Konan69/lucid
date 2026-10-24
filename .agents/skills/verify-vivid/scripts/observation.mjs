import * as NodeFSP from 'node:fs/promises'
import { Schema } from 'effect'
import { RpcSchema, RpcSerialization } from 'effect/rpc'
import { VividRpc } from '@vivid/contracts/rpc'

import { Account, decodeText } from './receipts.mjs'
export const Request = Schema.TaggedStruct('Request', {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Array(Schema.String)),
})
/** Decode each public stream with its production success codec. The first matching publication
 * is the receipt; closing our body releases the live subscription even when an assertion fails. */
export async function observe(state, { tag, payload, accept }) {
  const { cookie } = decodeText(
    Account,
    await NodeFSP.readFile(state.scratch + '/account.json', 'utf8'),
  )
  const procedure = VividRpc.requests.get(tag)
  if (!procedure) throw new Error('Unknown public stream ' + tag)
  const stream = procedure.successSchema
  if (!RpcSchema.isStreamSchema(stream)) throw new Error('Not a public stream ' + tag)
  const Packet = Schema.TaggedUnion({
    Chunk: { values: Schema.Array(RpcSerialization.ndjson.codecFor(stream.success)) },
    Exit: { exit: Schema.Json },
    Pong: {},
  })
  const candidates = (line) =>
    Packet.match(decodeText(Packet, line), {
      Chunk: ({ values }) => values,
      Exit: () => {
        throw new Error(tag + ' ended before the expected publication')
      },
      Pong: () => [],
    })
  const abort = new AbortController()
  try {
    const response = await fetch(state.web + '/api/rpc', {
      method: 'POST',
      headers: { cookie, origin: state.web, 'content-type': 'application/ndjson' },
      body: JSON.stringify(Request.make({ id: '1', tag, payload, headers: [] })) + '\n',
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(300_000)]),
    })
    if (response.status !== 200) throw new Error(tag + ' refused')
    let buffer = ''
    for await (const bytes of response.body) {
      buffer += Buffer.from(bytes).toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop()
      const match = lines.filter(Boolean).flatMap(candidates).find(accept)
      if (match) return match
    }
    throw new Error(tag + ' ended before the expected publication')
  } finally {
    abort.abort()
  }
}
