import { Option, Result } from 'effect'
import { useState } from 'react'
import { CITATION_ADDRESS, linkCitations, openDocument } from '../../data/documents'
import { useLiveData } from '../../data/live'
import { openWebLink, Prose } from '../../ui/Prose'
import { Label } from '../../ui/ui'

/**
 * Vivid's words as formatted text. A citation of something in the Library is a link the Thread
 * opens through the Library (the device downloads the original and hands it to the share sheet);
 * any other web link opens in the browser. A link that could not be opened says so under the text.
 *
 * `fresh` says the words are still arriving, which is when the ones they gain fade in (`Prose`).
 */
function Formatted({ text, fresh }: { text: string; fresh: boolean }) {
  const data = useLiveData()
  const [unopened, setUnopened] = useState<Option.Option<string>>(Option.none())

  function open(address: string) {
    setUnopened(Option.none())
    if (address.startsWith(CITATION_ADDRESS)) {
      const name = new URL(address).searchParams.get('name')
      if (name === null) return
      const path = `/source?name=${encodeURIComponent(name)}`
      void data.run(openDocument(data.session, path, name)).then((result) => {
        if (Result.isFailure(result)) setUnopened(Option.some(result.failure.message))
      })
      return
    }
    void openWebLink(address).then((opened) => {
      if (!opened) setUnopened(Option.some('That link could not be opened.'))
    })
  }

  return (
    <>
      <Prose text={linkCitations(text)} plain={text} fresh={fresh} onLink={open} />
      {Option.isSome(unopened) && (
        <Label size="label" tone="status-danger">
          {unopened.value}
        </Label>
      )}
    </>
  )
}

/**
 * Words that are all there: what an approval is for, a question Vivid asked. They are drawn as
 * they are, with nothing fading in.
 */
export function Words({ text }: { text: string }) {
  return <Formatted text={text} fresh={false} />
}

/**
 * The words of a reply, which may still be arriving: as much of it as is drawn so far, and
 * whether more is on its way (`useRevealed`). The two are one reading of one reply, so they are
 * taken together.
 */
export function Reply({ text, fresh }: { text: string; fresh: boolean }) {
  return <Formatted text={text} fresh={fresh} />
}
