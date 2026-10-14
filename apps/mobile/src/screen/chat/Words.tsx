import { Option, Result } from 'effect'
import { stretches } from '@vivid/state'
import { memo, useState } from 'react'
import { CITATION_ADDRESS, linkCitations, openDocument } from '../../data/documents'
import { useLiveData } from '../../data/live'
import { openWebLink, Prose } from '../../ui/Prose'
import { useRevealed } from '../../ui/reveal'
import { Display } from '../../parts/display'
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
 * A reply as the Person reads it: its words, with each display it wrote drawn where it stands in
 * them (`stretches`). Each stretch is keyed by where it starts in the reply, which never moves,
 * so a display is not remounted — and keeps what the Person picked in it — while the words after
 * it are still coming.
 *
 * Words that are already whole are drawn once and left alone (`Finished`, above): the formatter rebuilds
 * every element it draws when its text changes, so only what can still change is redrawn each
 * step, and the cost of a step does not grow with the reply. A display that is still arriving
 * fills itself in (`arriving`), as the web's does.
 */
export function Reply({
  text,
  streaming,
  live,
  onSay,
}: {
  text: string
  streaming: boolean
  /** Whether this reply is the newest thing in the Thread and Vivid has finished it. */
  live: boolean
  onSay: (words: string) => void
}) {
  const { drawn } = useRevealed(text, streaming)
  return (
    <>
      {stretches(drawn).map((stretch) =>
        stretch.kind === 'words' ? (
          <Finished key={stretch.from} text={stretch.text} />
        ) : (
          <Display key={stretch.from} text={stretch.text} arriving={!stretch.whole} live={live} onSay={onSay} />
        ),
      )}
    </>
  )
}
