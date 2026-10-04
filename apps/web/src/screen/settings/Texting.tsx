import { live, LiveState, useLive } from '../../data/live'
import { texting } from '../../data/texting'
import { TextingChannels } from './Channel'
import { Awaiting } from './Parts'

/**
 * Text Vivid: the Person gives their own phone number, texts a short code from that phone, and
 * from then on can write to Vivid from their messages app like they write to anyone.
 *
 * This is the live half only. Everything that is drawn is `TextingChannels` (`Channel.tsx`), which
 * is given the channels and the ways to act.
 */
export function Texting() {
  const channels = useLive(live.channels)
  if (!LiveState.$is('Ready')(channels)) return <Awaiting state={channels} />
  return <TextingChannels links={channels.value.channels} acts={texting} />
}
