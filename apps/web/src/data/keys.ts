/**
 * How this device writes its shortcuts. A Mac says ⌘ and everything else says Ctrl; the same
 * key does the work on both (`event.metaKey || event.ctrlKey`).
 */
const MAC = /Mac|iPhone|iPad/u.test(navigator.userAgent)

/** A shortcut as it is shown beside the thing it does: "⌘⇧O" on a Mac, "Ctrl+⇧O" elsewhere. */
export const shortcut = (keys: string) => (MAC ? `⌘${keys}` : `Ctrl+${keys}`)
