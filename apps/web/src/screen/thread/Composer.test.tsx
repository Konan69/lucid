// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { open } from '../../test/browser'

/**
 * One press of Enter is one message, however many presses React hears before it draws again.
 *
 * The composer used to send the words its last render had drawn. Presses of Enter handled in one
 * turn of the page, before React drew the emptied field, each read those same words: a browser
 * posted one request three times, as three Messages and three Runs (10 October 2026). So the
 * claim is made where it broke: the real `Composer` in a real React root, its field given real
 * `keydown` events, with every press inside one `act`, which is exactly "before React draws
 * again". What is counted is what the composer hands its Thread (`onSend`), its one way out.
 *
 * The page is a DOM (`happy-dom`) because React draws into one. The app's data modules still
 * open the live socket as they load, so the socket's other end and the network are the fixture's
 * (`test/browser.ts`). That fixture also puts a bare page in the DOM's place, which React cannot
 * draw into, so the DOM's own page is put back before the first module of the app is imported.
 */

/** The page as the DOM made it: each name `open` replaces with a bare stand-in of its own. */
const page = {
  window: globalThis.window,
  document: globalThis.document,
  location: globalThis.location,
  history: globalThis.history,
  addEventListener: globalThis.addEventListener,
  matchMedia: globalThis.matchMedia,
  localStorage: globalThis.localStorage,
}
open()
for (const [name, own] of Object.entries(page)) vi.stubGlobal(name, own)
// React flushes what `act` wraps only where the page says it is being tested.
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const { draft } = await import('../../data/drafts')
const { Composer } = await import('./Composer')

/**
 * Draws a composer for one place while Vivid works, with words already written there, and
 * answers its field and every message it hands on. It is taken off the page when the test ends,
 * whether or not the test passed.
 */
function composing(place: string, words: string) {
  const sent: Array<string> = []
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  onTestFinished(() => {
    act(() => root.unmount())
    container.remove()
  })
  act(() => {
    draft.keep(place, words)
    root.render(
      <Composer
        place={place}
        working
        onSend={(message) => {
          sent.push(message)
        }}
        onStop={() => undefined}
      />,
    )
  })
  const field = container.querySelector('textarea')
  if (field === null) throw new Error('The composer drew no field to write in.')
  return { field, sent }
}

/** Enter going down in the field, as the browser tells it: once, or again while it is held. */
const enter = (field: HTMLTextAreaElement, repeat = false) =>
  field.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', repeat, bubbles: true, cancelable: true }),
  )

describe('the composer', () => {
  it('sends words once when Enter is pressed three times before the field is drawn again', () => {
    const { field, sent } = composing('thread-pressed', 'Draft the invoice for Dami')

    act(() => {
      enter(field)
      enter(field)
      enter(field)
    })

    expect(sent).toEqual(['Draft the invoice for Dami'])
    expect(field.value).toBe('')
    expect(draft.in('thread-pressed')).toBe('')
  })

  it('sends words written between two presses as a message of their own', () => {
    const { field, sent } = composing('thread-between', 'Draft the invoice for Dami')

    act(() => {
      enter(field)
      draft.keep('thread-between', 'Send Ada a copy')
      enter(field)
    })

    expect(sent).toEqual(['Draft the invoice for Dami', 'Send Ada a copy'])
    expect(draft.in('thread-between')).toBe('')
  })

  it('sends nothing more while Enter is held, and keeps what is written meanwhile', () => {
    const { field, sent } = composing('thread-held', 'Draft the invoice for Dami')

    act(() => {
      enter(field)
      enter(field, true)
      draft.keep('thread-held', 'Send Ada a copy')
      enter(field, true)
    })

    expect(sent).toEqual(['Draft the invoice for Dami'])
    expect(field.value).toBe('Send Ada a copy')
  })
})
