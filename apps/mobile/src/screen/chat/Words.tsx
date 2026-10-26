import type { DisplaySource } from '@vivid/contracts'
import { Option, Result } from 'effect'
import { stretches } from '@vivid/state'
import { memo, useMemo, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { CITATION_ADDRESS, linkCitations, openDocument } from '../../data/documents'
import { useLiveData, useLiveValue } from '../../data/live'
import { openWebLink, Prose, type SiteMark } from '../../ui/Prose'
import { useRevealed } from '../../ui/reveal'
import { Display } from '../../parts/display'
import { useTheme } from '../../theme'
import { EDGE, Label, radius } from '../../ui/ui'

/**
 * The Person's Integrations that name both a site and a mark, for drawing links to them as chips.
 * Read from the live list, so a newly connected service's links take its mark at once; one array
 * per list, so the renderer is sent a new style only when the list changes.
 */
function useSiteMarks(): ReadonlyArray<SiteMark> {
  const data = useLiveData()
  const connections = useLiveValue(data.live.connections)
  return useMemo(
    () =>
      Option.match(connections, {
        onNone: () => [],
        onSome: ({ connections: all }) =>
          all.flatMap((connection) =>
            connection.site === null || connection.mark === null
              ? []
              : [{ site: connection.site, icon: connection.mark }],
          ),
      }),
    [connections],
  )
}

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
  const marks = useSiteMarks()

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
      <Prose text={linkCitations(text)} plain={text} fresh={fresh} marks={marks} onLink={open} />
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
 * Words of a reply, formatted again only when their text or whether they are still arriving
 * changes, so a stretch that is whole is left alone while the reply goes on.
 */
const Finished = memo(Formatted)

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
  source,
  text,
  streaming,
  making,
  settled,
  live,
  onSay,
}: {
  /** The reply as Flue stored it, which every program drawn from it names. */
  source: DisplaySource
  text: string
  /**
   * Whether this reply's own parts are still streaming. A display waits for it beside `making`,
   * because a reply can still be streaming after it stops being the newest thing in the Thread
   * (the Person writes while it arrives), and then `making` alone would let its Queries run early.
   */
  streaming: boolean
  /**
   * Whether Vivid is still making the newest reply and this is it. A display whose own end has
   * arrived still waits for the reply's: the server runs a program only from a reply it has stored
   * whole.
   */
  making: boolean
  /** Whether Flue has settled the submission this reply answers (`Message`, `settled`). */
  settled: boolean
  /** Whether this reply is the newest thing in the Thread and Vivid has finished it. */
  live: boolean
  onSay: (words: string) => void
}) {
  const { drawn, fresh } = useRevealed(text, streaming)
  return (
    <>
      {stretches(drawn).map((stretch) =>
        stretch.kind === 'words' ? (
          <Bubble key={stretch.from}>
            <Finished text={stretch.text} fresh={fresh} />
          </Bubble>
        ) : (
          <Display
            source={source}
            key={stretch.from}
            text={stretch.text}
            arriving={making || streaming || !settled || !stretch.whole}
            live={live}
            onSay={onSay}
          />
        ),
      )}
    </>
  )
}

/**
 * One of Vivid's messages: its words on the Thread's quiet surface, so where one message ends and
 * the next begins can be seen (the owner, 26 October 2026: "we need message cards to know it's a
 * new message"). The Person's own bubble is the warm `user-bubble` (`Said.tsx`); Vivid's is the
 * `subtle` surface with a hairline, the same pair the Integration card sits in. A display is not
 * in one: it is a surface of its own.
 */
function Bubble({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        maxWidth: '100%',
        paddingHorizontal: 14,
        paddingVertical: 9,
        borderRadius: radius.card,
        borderCurve: 'continuous',
        borderWidth: EDGE,
        borderColor: c['border-subtle'],
        backgroundColor: c.subtle,
      }}
    >
      {children}
    </View>
  )
}
