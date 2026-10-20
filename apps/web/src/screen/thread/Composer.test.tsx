// @vitest-environment happy-dom
import { Option } from 'effect'
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
type Onward = import('./Composer').Onward

/**
 * Draws a composer for one place while Vivid works, with words already written there, and
 * answers its field and every message it hands on. It is taken off the page when the test ends,
 * whether or not the test passed.
 */
function composing(place: string, words: string, asked: Option.Option<Onward> = Option.none()) {
  const sent: Array<string> = []
  const stops: Array<'stop'> = []
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
        onStop={() => {
          stops.push('stop')
        }}
        asked={Option.getOrUndefined(asked)}
      />,
    )
  })
  const field = container.querySelector('textarea')
  if (field === null) throw new Error('The composer drew no field to write in.')
  const button = (name: string) => {
    const found = Array.from(container.querySelectorAll('button')).find(
      (one) => one.getAttribute('aria-label') === name || one.textContent === name,
    )
    if (found === undefined) throw new Error(`The composer drew no button named ${name}.`)
    return found
  }
  return { container, field, sent, stops, button }
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

/**
 * While a question from Vivid is up, the banner over the composer has no button: the composer's
 * own footer moves on from the question when nothing is written, and sends words when there are
 * words. What is counted is which of its two ways out the composer took.
 */
describe('the composer while a question is up', () => {
  /** A question in the middle of a request, and every move the composer asks for. */
  const question = (patch: Partial<Pick<Onward, 'first' | 'last' | 'ready'>>) => {
    const moves: Array<'next' | 'back'> = []
    const asked: Onward = {
      first: false,
      last: false,
      ready: true,
      onNext: () => moves.push('next'),
      onBack: () => moves.push('back'),
      ...patch,
    }
    return { moves, asked: Option.some(asked) }
  }

  it('moves on from the question, by Enter and by its button, when nothing is written', () => {
    const { moves, asked } = question({})
    const { field, sent, button } = composing('asked-empty', '', asked)

    // A block body: `act` treats a callback that returns a value as an asynchronous one.
    act(() => {
      enter(field)
    })
    act(() => button('Next question').click())

    expect(moves).toEqual(['next', 'next'])
    expect(sent).toEqual([])
  })

  it('does not move on from a question that has no answer yet', () => {
    const { moves, asked } = question({ ready: false, last: true })
    const { field, button } = composing('asked-unready', '', asked)

    // A block body: `act` treats a callback that returns a value as an asynchronous one.
    act(() => {
      enter(field)
    })

    expect(button('Submit answers').disabled).toBe(true)
    expect(moves).toEqual([])
  })

  it('sends words that are written, and leaves the question where it is', () => {
    const { moves, asked } = question({})
    const { field, sent } = composing('asked-words', 'Skip that, just send it', asked)

    // A block body: `act` treats a callback that returns a value as an asynchronous one.
    act(() => {
      enter(field)
    })

    expect(sent).toEqual(['Skip that, just send it'])
    expect(moves).toEqual([])
  })

  it('stops Vivid, which keeps working after it asks, from a button of its own', () => {
    const { moves, asked } = question({})
    const { sent, stops, button } = composing('asked-working', '', asked)

    act(() => button('Stop').click())

    expect(stops).toEqual(['stop'])
    expect(button('Next question').disabled).toBe(false)
    expect(moves).toEqual([])
    expect(sent).toEqual([])
  })

  it('keeps Stop beside Send when words are typed under an open question', () => {
    const { moves, asked } = question({})
    const { field, sent, stops, button } = composing('asked-working-words', '', asked)

    act(() => draft.keep('asked-working-words', 'Skip that, just send it'))
    act(() => button('Stop').click())

    expect(stops).toEqual(['stop'])
    expect(field.value).toBe('Skip that, just send it')
    expect(moves).toEqual([])
    expect(sent).toEqual([])
    act(() => button('Send').click())
    expect(sent).toEqual(['Skip that, just send it'])
  })

  it('keeps one Stop and holds Send while a drafted attachment uploads under a question', async () => {
    const { asked } = question({})
    const { container, field, sent, stops, button } = composing('asked-upload', 'Read this', asked)
    // Hold only the browser's network boundary: the real attachment flow stays uploading.
    const started = new Promise<XMLHttpRequest>((resolve) => {
      vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(function (this: XMLHttpRequest) {
        resolve(this)
      })
    })
    onTestFinished(() => vi.restoreAllMocks())
    const picker = container.querySelector('input[type="file"]')
    if (!(picker instanceof HTMLInputElement)) throw new Error('The composer drew no file picker.')
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Trip notes'], 'trip.txt', { type: 'text/plain' }))
    await act(async () => {
      picker.files = transfer.files
      picker.dispatchEvent(new Event('change', { bubbles: true }))
      await started
    })
    expect(container.querySelectorAll('button[aria-label="Stop"]')).toHaveLength(1)
    expect(button('Send').disabled).toBe(true)
    act(() => button('Stop').click())
    expect(stops).toEqual(['stop'])
    expect(sent).toEqual([])
    expect(field.value).toBe('Read this')
    // A network refusal finishes the held request without creating a document fixture.
    await act(async () => {
      const uploading = await started
      uploading.dispatchEvent(new Event('error'))
    })
    expect(button('Send').disabled).toBe(false)
  })

  it('goes back to the question before from its quiet button, from the second question on', () => {
    const { moves, asked } = question({})
    const { button } = composing('asked-back', '', asked)

    act(() => button('Previous').click())

    expect(moves).toEqual(['back'])
  })
})
