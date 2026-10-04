import type { Channel, ChannelLink } from '@vivid/contracts'
import {
  connectChannel,
  disconnectChannel,
  textingRefusal,
  withLink,
  type TextingFailure,
} from '@vivid/state'
import { Option, Result } from 'effect'
import { run } from './app'
import { live } from './live'

/**
 * Connecting and disconnecting a messaging app, for the web app's screens.
 *
 * These are not `change` calls: a channel's refusals are its own (`ChannelFailure`), each said in
 * its own words, and `change` only carries the product's general ones. So the call is run as a
 * program, and its answer is laid over the live list by hand once it is known.
 */

/**
 * What one call came to. An answer is shown at once in every screen reading the channels, and
 * says nothing; a refusal is the one sentence to show under the control that asked.
 */
const settled = (result: Result.Result<ChannelLink, TextingFailure>): Option.Option<string> => {
  if (Result.isFailure(result)) return Option.some(textingRefusal(result.failure))
  const link = result.success
  // The server has already accepted this, so the expectation is settled the moment it is made:
  // it holds the answer on screen until the watch sends its own next result.
  live.channels.expect((current) => withLink(current, link))(true)
  return Option.none()
}

/** What a connect control is given to act with, so it can be drawn with none of this attached. */
export interface TextingActs {
  /** Gives the Person's number to a channel, or asks for a new code for the same number. */
  readonly connect: (channel: Channel, written: string) => Promise<Option.Option<string>>
  /** Takes the Person's number off a channel. */
  readonly disconnect: (channel: Channel) => Promise<Option.Option<string>>
}

export const texting: TextingActs = {
  connect: (channel, written) => run(connectChannel(channel, written)).then(settled),
  disconnect: (channel) => run(disconnectChannel(channel)).then(settled),
}
