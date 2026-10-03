import { BrowserAction, DesktopAction, type ScreenPoint } from '@vivid/contracts'

/**
 * What Vivid does on its Computer, in words. An Approval card and the activity line under a reply
 * both say the step this way, on every surface, so a Person reads the same sentence for the same
 * action wherever they see it.
 */

/** A place on the screen, as a person would point at it. */
const at = (point: ScreenPoint) => `${point.x}, ${point.y}`

/** One step in the browser on Vivid's Computer. */
export const browserStep = (action: BrowserAction): string =>
  BrowserAction.match(action, {
    Open: ({ address }) => `Open ${address}`,
    Read: () => 'Read the page',
    Click: ({ target }) => `Click “${target}”`,
    Type: ({ target, text }) => `Type “${text}” into “${target}”`,
    Press: ({ key }) => `Press ${key}`,
    Screenshot: () => 'Look at the page',
    Scroll: ({ direction }) => `Scroll ${direction}`,
    Back: () => 'Go back',
    Forward: () => 'Go forward',
    Wait: ({ seconds }) => `Wait ${seconds} seconds`,
    OpenTab: ({ address }) => `Open ${address} in a new tab`,
    ShowTab: ({ tab }) => `Switch to tab ${tab}`,
    CloseTab: ({ tab }) => `Close tab ${tab}`,
  })

const CLICKS = { 1: 'Click', 2: 'Double-click', 3: 'Triple-click' } as const

/** One pointer or keyboard action on the Computer's desktop. */
export const desktopStep = (action: DesktopAction): string =>
  DesktopAction.match(action, {
    Look: () => 'Look at the screen',
    Click: ({ at: point, button, times }) =>
      button === 'left'
        ? `${CLICKS[times]} at ${at(point)}`
        : `${CLICKS[times]} the ${button} button at ${at(point)}`,
    Move: ({ to }) => `Move the pointer to ${at(to)}`,
    Drag: ({ from, to }) => `Drag from ${at(from)} to ${at(to)}`,
    Scroll: ({ direction }) => `Scroll ${direction}`,
    Type: ({ text }) => `Type “${text}”`,
    Press: ({ keys }) => `Press ${keys}`,
    Wait: ({ seconds }) => `Wait ${seconds} seconds`,
  })
