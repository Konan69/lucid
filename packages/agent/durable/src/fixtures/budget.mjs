// JavaScript hosts can supply non-numeric options despite the published TypeScript signature.
// This checked-in wire fixture proves the Promise ingress returns its tagged configuration error.
import { respond } from '../main.ts'

/** Pass the host's raw budget exactly as a JavaScript integration does, without a TypeScript cast. */
export function requestBudget(harness, input, context) {
  return respond(
    harness,
    input.conversationId,
    {
      request: new Request('http://durable.test/chat', { method: 'POST', body: '{}' }),
      options: { maxPartBytes: input.value },
    },
    context,
  )
}
