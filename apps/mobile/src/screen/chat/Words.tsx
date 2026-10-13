import { Option, Result } from 'effect'
import { settledAt } from '@vivid/state'
import { memo, useState } from 'react'
import { CITATION_ADDRESS, linkCitations, openDocument } from '../../data/documents'
import { useLiveData } from '../../data/live'
import { openWebLink, Prose } from '../../ui/Prose'
import { useRevealed } from '../../ui/reveal'
import { Label } from '../../ui/ui'

/**
 * Vivid's words as formatted text. A citation of something in the Library is a link the Thread
 * opens through the Library (the device downloads the original and hands it to the share sheet);
 * any other web link opens in the browser. A link that could not be opened says so under the text.
 */
export function Words({ text }: { text: string }) {
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
      <Prose text={linkCitations(text)} plain={text} onLink={open} />
      {Option.isSome(unopened) && (
        <Label size="label" tone="status-danger">
          {unopened.value}
        </Label>
      )}
    </>
  )
}

/** Words that do not change while a reply goes on, so they are formatted once and left alone. */
const Finished = memo(Words)

/**
 * The words of a reply, which may still be arriving. They are let out evenly (`useRevealed`),
 * and while they are, the reply is drawn in two parts: what is finished (`settledAt`) and the
 * block now arriving. The formatter rebuilds every element it draws when its text changes, so
 * only the arriving block is rebuilt on each step and the cost of a step does not grow with the
 * reply. Once it is all there it is one piece again, formatted as written.
 */
export function Reply({ text, streaming }: { text: string; streaming: boolean }) {
  const { drawn, fresh } = useRevealed(text, streaming)
  const cut = fresh ? settledAt(drawn) : 0
  return (
    <>
      {cut > 0 && <Finished text={drawn.slice(0, cut)} />}
      <Words text={drawn.slice(cut)} />
    </>
  )
}
