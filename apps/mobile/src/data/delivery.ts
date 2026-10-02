import { Option } from 'effect'

/**
 * Which delivery a message is. Pure, so the rule that keeps a message from being said twice can be
 * read and tested without a screen.
 *
 * The server admits a message under a key and answers. When that answer is lost on the way back
 * (a phone leaving a network does this), the phone cannot tell an admitted message from a refused
 * one, and the Person is right to send it again. Under a new key that is a second Message and a
 * second Run, and Vivid does the work twice. Under the same key it is the delivery the server
 * already has, and nothing is repeated. So a key is made once for a message and stays with its
 * words until they are known to have arrived.
 */

/** Words on their way to a Thread, and the key that names this one delivery to the server. */
export interface Delivery {
  readonly words: string
  readonly key: string
}

/** A delivery that was sent and not known to arrive, and what to tell the Person about it. */
export interface Unsent extends Delivery {
  readonly why: string
}

/**
 * The delivery for words that are about to be sent.
 *
 * When they are the words that last did not arrive, however they got back into the Person's hands
 * (the retry button, or the composer the words were put back in), it is that same delivery under
 * its own key. Any other words are a new message with a key of their own, made by `fresh`.
 */
export const deliveryOf = (
  unsent: Option.Option<Unsent>,
  words: string,
  fresh: () => string,
): Delivery =>
  Option.match(
    Option.filter(unsent, (failed) => failed.words === words),
    {
      onNone: () => ({ words, key: fresh() }),
      onSome: (failed) => ({ words, key: failed.key }),
    },
  )
