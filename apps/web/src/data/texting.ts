import { connectChannel, disconnectChannel, textingSettled, type TextingActs } from '@vivid/state'
import { run } from './app'
import { live } from './live'

/**
 * Connecting and disconnecting a messaging app, for the web app's screens: the shared programs,
 * run on the app's socket, with each answer laid over the app's live list of channels.
 */
const settled = textingSettled(live.channels)

export const texting: TextingActs = {
  connect: (channel, written) => run(connectChannel(channel, written)).then(settled),
  disconnect: (channel) => run(disconnectChannel(channel)).then(settled),
}
