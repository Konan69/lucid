import { wakeComputer } from '@vivid/client-runtime'
import { run } from './app'

/** Whether a wake is on its way: two ways to the view in one press (the card's link opens the
 * panel and brings the Computer forward) ask once. */
let waking = false

/**
 * Arriving at Vivid's computer turns it on (`wakeComputer`). It is called where the Person asks
 * to see the Computer (opening the panel, bringing the Computer in front of the pages), never by
 * the panel as it draws: a panel that started the machine whenever it showed one turned off
 * would start it again the moment the Person turned it off. A refusal is not said here; the
 * panel shows where the Computer stands.
 */
export const wake = () => {
  if (waking) return
  waking = true
  void run(wakeComputer()).finally(() => {
    waking = false
  })
}
