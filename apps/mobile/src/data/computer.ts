import { ComputerScreen, ComputerState, type Computer } from '@vivid/contracts'
import type { FaceMood } from '@vivid/marks'
import { Option } from 'effect'

/**
 * Vivid's computer, in words: where it stands, what that means for the Person, and the one thing
 * they can do about it. Pure readings of the Computer's live record; the screen
 * (`screen/Computer.tsx`) only draws what these return.
 *
 * The sentences are the web panel's (`glass` and `RESTING` in `apps/web/src/screen/Computer.tsx`),
 * so the same machine is described the same way in a browser and on a phone. The one difference
 * is honest: the web says "you are watching" while Vivid has the keyboard, because its panel
 * shows the screen. The phone's own page does not draw the screen (it opens it, `viewerOf`), so
 * it does not say so.
 */
export interface Standing {
  /** One line for the bar: where the computer stands and who is using it. */
  readonly glass: string
  readonly title: string
  readonly detail: string
  /** The look on Vivid's face: thinking while it starts, asleep while it is off. */
  readonly mood: FaceMood
  /** What the button that starts it says, where starting it is what there is to do. */
  readonly start: Option.Option<string>
}

const TURN_ON = Option.some('Turn it on')

/** Where a Person's Computer stands, said for a Person. */
export const standingOf = (computer: Computer): Standing =>
  ComputerState.match<Standing>(computer.state, {
    Absent: () => ({
      glass: 'Not started yet',
      title: 'A computer of its own',
      detail:
        'Vivid can use a real machine for work that needs one: running a script, reading a site, filling a form. It is yours alone and keeps its files and sign-ins between uses.',
      mood: 'neutral',
      start: TURN_ON,
    }),
    Starting: () => ({
      glass: 'Starting up…',
      title: 'Starting up',
      detail: 'This takes a few seconds.',
      mood: 'thinking',
      start: Option.none(),
    }),
    Running: () =>
      computer.heldByPerson
        ? {
            glass: 'You have the keyboard',
            title: 'Turned on',
            detail: 'Vivid will not act on its computer until you hand it back.',
            mood: 'neutral',
            start: Option.none(),
          }
        : {
            glass: 'Vivid has the keyboard',
            title: 'Turned on',
            detail: 'Take over to stop Vivid acting on its computer until you hand it back.',
            mood: 'happy',
            start: Option.none(),
          },
    Stopped: () => ({
      glass: 'Turned off · files and sign-ins kept',
      title: 'Turned off',
      detail: 'Its files and sign-ins are kept.',
      mood: 'asleep',
      start: TURN_ON,
    }),
    Failed: ({ reason }) => ({
      glass: 'Did not start',
      title: 'It did not start',
      // The machine's own reason, as the server recorded it.
      detail: reason,
      mood: 'neutral',
      start: Option.some('Try again'),
    }),
  })

/**
 * The page on which a running Computer's screen can be watched from a phone: the machine
 * provider's own viewer (`ComputerScreen.Viewer`), which is a web page built for touch as well as
 * a pointer (Boat's `stream.html` has a device-width viewport and its own touch handling, read on
 * 10 October 2026). The app has no web view among its dependencies, so the page is opened in the
 * system browser and not drawn inside the app.
 *
 * A relayed screen (`ComputerScreen.Relay`) has no page: it is a remote-framebuffer socket that
 * only the web panel's client can draw, so for it, and for a Computer that is not running, there
 * is nothing to open.
 */
export const viewerOf = (computer: Computer): Option.Option<string> =>
  ComputerState.guards.Running(computer.state) &&
  ComputerScreen.guards.Viewer(computer.state.screen)
    ? Option.some(computer.state.screen.address)
    : Option.none()
