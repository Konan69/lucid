import type { Channel } from '@vivid/contracts'
import { connectChannel, disconnectChannel, textingSettled } from '@vivid/state'
import type { Option } from 'effect'
import { run } from './app'
import { live } from './live'

/**
 * What a connect control is given to act with, so it can be drawn with none of this attached.
 * Each answers with the one sentence to show when it was refused, and with nothing when it was not.
 *
 * It is declared here and not beside the shared programs (`@vivid/state`), because a Promise is
 * what an event handler awaits: that is this app's boundary, and the shared package only describes
 * work as Effects.
 */
export interface TextingActs {
  /** Gives the Person's number to a channel, or asks for a new code for the same number. */
  readonly connect: (channel: Channel, written: string) => Promise<Option.Option<string>>
  /** Takes the Person's number off a channel. */
  readonly disconnect: (channel: Channel) => Promise<Option.Option<string>>
}

/**
 * Connecting and disconnecting a messaging app, for the web app's screens: the shared programs,
 * run on the app's socket, with each answer laid over the app's live list of channels.
 */
const settled = textingSettled(live.channels)

export const texting: TextingActs = {
  connect: (channel, written) => run(connectChannel(channel, written)).then(settled),
  disconnect: (channel) => run(disconnectChannel(channel)).then(settled),
}
