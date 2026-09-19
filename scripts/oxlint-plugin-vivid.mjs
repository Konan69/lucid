/**
 * Vivid domain code models expected failures in Effect's typed error channel.
 * A JavaScript catch clause bypasses that contract and hides recoverable errors
 * from service callers, so legacy catches are warnings until the ratchet reaches zero.
 */
const noTryCatch = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Keep expected application failures in the typed Effect error channel.',
    },
    schema: [],
    messages: {
      catch:
        'Do not use catch for expected failures in app/domain code. Use typed Effect failures and recover at the owning boundary.',
    },
  },
  create(context) {
    return {
      TryStatement(node) {
        if (node.handler !== null) context.report({ node: node.handler, messageId: 'catch' })
      },
    }
  },
}

export default {
  meta: { name: 'vivid' },
  rules: {
    'no-try-catch': noTryCatch,
  },
}
