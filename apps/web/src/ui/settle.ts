import { still, timing } from './motion'

/**
 * Lists whose contents arrive and move on their own: a Thread that starts working jumps to
 * another part of the sidebar, a new Message lands under the last. Nothing the Person did caused
 * it, so there is no event handler to animate from; these watch the list itself.
 *
 * Both are `ref` callbacks. They watch with a `MutationObserver`, which is told of a change after
 * React has made it and before the browser draws it. That is the one moment a list can be played
 * from where it was to where it now is. Neither runs on anything but an item being added or
 * taken away: text that streams into an item changes no list, so it costs nothing here.
 */

/** More than this arriving at once is a list loading, not something happening in it. */
const TOGETHER = 2

const MOVING = 'settle-move'

/** An item rising into its place as it appears: the `motion-enter` class, played by script. */
function arrive(item: Element) {
  const from = still() ? { opacity: 0 } : { opacity: 0, translate: '0 6px' }
  item.animate([from, {}], timing('enter'))
}

/**
 * Plays each new item of a list in as it arrives: `ref` it on the list, and mark the items with
 * `data-arrives`. What is in the list when it is first drawn does not move, and neither does a
 * history that loads all at once: reading back through a Thread is not an event.
 */
export function arriving(list: HTMLElement | null) {
  if (list === null) return undefined
  const watcher = new MutationObserver((changes) => {
    const added = changes
      .flatMap((change) => Array.from(change.addedNodes))
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .filter((node) => node.dataset.arrives !== undefined && node.isConnected)
    if (added.length > 0 && added.length <= TOGETHER) added.forEach(arrive)
  })
  // Direct children only: what happens inside an item is that item's own business.
  watcher.observe(list, { childList: true })
  return () => watcher.disconnect()
}

/** Where an item is laid out, down from the top of its list. Scrolling does not change it. */
const placeIn = (list: HTMLElement, item: HTMLElement) =>
  item.getBoundingClientRect().top - list.getBoundingClientRect().top

/**
 * Where an item is laid out and where it is drawn, which differ while it is still travelling
 * from an earlier move. The move is ended here, so the next one starts from where the eye last
 * saw the item and not from where it was heading.
 */
function measure(list: HTMLElement, item: HTMLElement) {
  const travelling = item.getAnimations().filter((animation) => animation.id === MOVING)
  if (travelling.length === 0) {
    const laid = placeIn(list, item)
    return { laid, drawn: laid }
  }
  const drawn = placeIn(list, item)
  for (const animation of travelling) animation.cancel()
  return { laid: placeIn(list, item), drawn }
}

/**
 * Keeps a list settled as it changes: an item that has a new place glides to it, an item that is
 * new rises in, and everything below a gap closes up. `ref` it on the element that scrolls the
 * list, and give every item that can move a `data-moves` name that is its own for as long as it
 * lives (a Thread's id, a caption's label). An item that goes from one part of the list to
 * another is a new element with the same name, and still glides.
 *
 * It is first-last-invert-play: the places are measured once after the change, each item is put
 * back where it was with a transform, and the transform is played out. Nothing is laid out again
 * while they travel. Under reduced motion nothing travels; a new item only fades in.
 */
export function settling(list: HTMLElement | null) {
  if (list === null) return undefined
  /** Every item that can move, with the name it is followed by. */
  const items = () =>
    Array.from(list.querySelectorAll<HTMLElement>('[data-moves]')).flatMap((item) =>
      item.dataset.moves === undefined ? [] : [{ item, name: item.dataset.moves }],
    )
  let places = new Map(items().map(({ item, name }) => [name, placeIn(list, item)]))

  const watcher = new MutationObserver(() => {
    const before = places
    const measured = items().map(({ item, name }) => {
      const { laid, drawn } = measure(list, item)
      return { item, name, laid, drawn }
    })
    places = new Map(measured.map(({ name, laid }) => [name, laid]))
    // A change made from the keyboard is drawn at once; see `instantly`.
    if (document.documentElement.dataset.motion === 'off') return

    const fresh = measured.filter(({ name }) => !before.has(name))
    if (fresh.length <= TOGETHER) for (const { item } of fresh) arrive(item)
    if (still()) return

    for (const { item, name, laid, drawn } of measured) {
      const was = before.get(name)
      if (was === undefined) continue
      // Where it was drawn before the change: its old place, plus whatever it had left to travel.
      const from = was + (drawn - laid) - laid
      // Under a pixel is a rounding difference; over a screen is a jump nobody can follow.
      if (Math.abs(from) < 1 || Math.abs(from) > innerHeight) continue
      item.animate([{ translate: `0 ${from}px` }, { translate: '0 0' }], {
        ...timing('layout'),
        id: MOVING,
      })
    }
  })
  watcher.observe(list, { childList: true, subtree: true })
  return () => watcher.disconnect()
}
