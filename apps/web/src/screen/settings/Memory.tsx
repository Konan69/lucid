import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  MemoryExport,
  type MemoryForgetId,
  type MemoryLine,
  type SavedMemory,
} from '@vivid/contracts'
import { LiveState, makeWhen, remembering, thisReader } from '@vivid/state'
import { ChevronDown, Download as DownloadIcon } from 'lucide-react'
import { Effect, Option, Result, Schema } from 'effect'
import { useState } from 'react'
import { act, running } from '../../data/app'
import { memory, useLive } from '../../data/live'
import { orSay } from '../../data/said'
import { router } from '../../router'
import { Button } from '../../ui/button'
import { cn } from '../../ui/cn'
import { Markdown } from '../../ui/Markdown'
import { Textarea } from '../../ui/textarea'
import { Awaiting, Empty, Refusal, Row, Section } from './Parts'

const when = makeWhen(thisReader())

/** The most a remembered sentence can hold, as `MemoryEntry` in the contract checks it. */
const SENTENCE_LIMIT = 200

/** Whether Vivid was told or worked it out, in the Person's words. */
const BASIS = { said: 'You said', guessed: 'Vivid’s guess' } as const

/**
 * What Vivid remembers about the Person: the pages it keeps standing (about them, how to reach
 * them, and Vivid's own name and character as it wrote them), each whole, then the newest things
 * it remembers, one line each. It is the memory Vivid reads before every response, read from the
 * Person's cell (`remembering` in `@vivid/state`). Opening a line reads it whole; from there the
 * Person corrects it or has Vivid forget it.
 *
 * The reading is the one begun as Settings opened (`warm.ts`), so the section is drawn without a
 * wait; every opening of Settings reads it again.
 */
export function Memory() {
  const [visit] = useState(memory.current)
  const reading = useAtomValue(visit.reading)
  const send = useAtomSet(visit.send)
  const [opened] = useState(() => Date.now())
  return (
    <>
      <Remembered reading={reading} send={send} now={opened} />
      <Download />
    </>
  )
}

/**
 * Everything the Person's memory holds, read whole on the server (`ExportMemory`) and written out
 * as the contract encodes it, so the file is the same JSON the server keeps and can be read
 * without Vivid.
 */
const encodeExport = Schema.encodeEffect(MemoryExport)
const exported = Effect.fn('Memory.exported')(function* () {
  const client = yield* VividRpcClient
  return yield* encodeExport(yield* client.ExportMemory())
})

/** Hands the browser one file to save, named for the day it was taken. */
const save = (file: typeof MemoryExport.Encoded) => {
  const day = new Date(file.exportedAt).toISOString().slice(0, 10)
  const address = URL.createObjectURL(
    new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = address
  link.download = `vivid-memory-${day}.json`
  link.click()
  URL.revokeObjectURL(address)
}

const download = () =>
  void act(
    orSay(
      Effect.map(running(exported()), Result.map(save)),
      'Your memory could not be downloaded. Try again.',
    ),
  )

/** The way to take a copy of everything Vivid remembers about the Person. */
function Download() {
  return (
    <Section title="Your copy">
      <Row
        label="Download everything Vivid remembers"
        detail="Every page and line, whole, as one file you can keep."
      >
        <Button size="sm" variant="outline" onClick={download}>
          <DownloadIcon />
          Download
        </Button>
      </Row>
    </Section>
  )
}

/**
 * Everything the section draws, from the visit's reading alone. It starts nothing itself, so
 * every state can be drawn without a server behind it.
 */
export function Remembered({
  reading,
  send,
  now,
}: {
  reading: remembering.Remembering
  send: (event: remembering.Sent) => void
  now: number
}) {
  return remembering.Remembering.match(reading, {
    Reading: () => <Awaiting state={LiveState.Loading()} />,
    Unread: () => (
      <Section title="What Vivid remembers">
        <div className="flex flex-col items-center gap-3 px-4 py-6">
          <p className="text-center text-label text-ink-3">
            Unable to load what Vivid remembers right now.
          </p>
          <Button size="sm" variant="outline" onClick={() => send(remembering.events.Retry())}>
            Try again
          </Button>
        </div>
      </Section>
    ),
    Shown: (shown) => <Shown shown={shown} send={send} now={now} />,
  })
}

type ShownReading = typeof remembering.Remembering.cases.Shown.Type

/** The standing pages, then the lines, then the way to older ones. */
function Shown({
  shown,
  send,
  now,
}: {
  shown: ShownReading
  send: (event: remembering.Sent) => void
  now: number
}) {
  const page = (layer: SavedMemory['layer']) =>
    shown.standing.filter((standing) => standing.layer === layer)
  const vivid = [...page('self'), ...page('soul')]
  const open = remembering.openAddress(shown.entry)
  // A line being forgotten leaves the list at once; it comes back if the cell refuses.
  const lines = remembering.Entry.guards.Forgetting(shown.entry)
    ? shown.lines.filter((line) => !remembering.isAt(line, open))
    : shown.lines
  return (
    <>
      <Pages title="About you" pages={page('person')} />
      <Pages title="How Vivid reaches you" pages={page('attention')} />
      <Pages title="Vivid" pages={vivid} />
      <Notice entry={shown.entry} />
      {remembering.Entry.guards.Handed(shown.entry) && <Forgotten id={shown.entry.forget} />}
      <Section title="What Vivid remembers">
        {lines.length === 0 && (
          <Empty>When you tell Vivid something that matters later, it shows up here.</Empty>
        )}
        {lines.map((line) => (
          <Line
            key={`${line.layer}/${line.file}`}
            line={line}
            entry={remembering.isAt(line, open) ? shown.entry : CLOSED}
            send={send}
            now={now}
          />
        ))}
        <Older older={shown.older} send={send} />
      </Section>
    </>
  )
}

const CLOSED = remembering.Entry.cases.Closed.make({})

/** One standing page's section, absent until Vivid has written the page. */
function Pages({ title, pages }: { title: string; pages: ReadonlyArray<SavedMemory> }) {
  if (pages.length === 0) return null
  return (
    <Section title={title}>
      {pages.map((standing) => (
        // Settings reads at the label size; a reply's Markdown is drawn at the body size.
        <div key={standing.file} className="px-4 py-3 wrap-break-word *:text-label">
          <Markdown content={standing.body} />
        </div>
      ))}
    </Section>
  )
}

/**
 * What happened to an entry the Person is no longer looking at: one that could not be forgotten
 * is back in the list, and one Vivid removed before their change reached it is gone.
 */
function Notice({ entry }: { entry: remembering.Entry }) {
  const said = remembering.Entry.match(entry, {
    Unforgotten: () => 'That could not be forgotten, so it is back in the list. Try again.',
    Vanished: () => 'Vivid no longer remembers that, so it has left the list.',
    Closed: () => null,
    Opening: () => null,
    Unopened: () => null,
    Open: () => null,
    Moved: () => null,
    Editing: () => null,
    Saving: () => null,
    Unsaved: () => null,
    Rereading: () => null,
    Forgetting: () => null,
    Handed: () => null,
  })
  return <Refusal message={said} />
}

/**
 * Where a forget the Person pressed stands. Vivid carries it out in the background across what
 * it remembers, its Watches and the work queued with it, so this reads the forget's receipt live
 * and says Forgotten only once nothing that can bring it back remains.
 */
function Forgotten({ id }: { id: MemoryForgetId }) {
  const receipt = useLive(memory.forgets.get(id))
  const words = LiveState.$match(receipt, {
    Loading: () => remembering.forgetWords(remembering.pendingForget(id)),
    Ready: ({ value }) => remembering.forgetWords(value),
    Failed: () => ({ headline: 'Unable to tell how forgetting it went right now.', lines: [] }),
  })
  return (
    <div role="status" className="mb-3 rounded-control bg-surface-2 px-3 py-2 edge">
      <p className="text-label text-ink">{words.headline}</p>
      {words.lines.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {words.lines.map((line) => (
            <li key={line} className="text-label text-ink-3">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One remembered thing: its sentence, whether the Person said it or Vivid guessed it, and when
 * it last changed. Pressed, it opens below itself with its whole text and what can be done with
 * it; one line is open at a time.
 */
function Line({
  line,
  entry,
  send,
  now,
}: {
  line: MemoryLine
  entry: remembering.Entry
  send: (event: remembering.Sent) => void
  now: number
}) {
  const expanded = remembering.Entry.match(entry, {
    Closed: () => false,
    Vanished: () => false,
    Forgetting: () => false,
    Handed: () => false,
    Unforgotten: () => false,
    Opening: () => true,
    Unopened: () => true,
    Open: () => true,
    Moved: () => true,
    Editing: () => true,
    Saving: () => true,
    Unsaved: () => true,
    Rereading: () => true,
  })
  const panel = `memory-${line.layer}-${line.file}`
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? panel : undefined}
        onClick={() =>
          send(expanded ? remembering.events.Close() : remembering.events.Open({ line }))
        }
        className="flex min-h-14 w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-start outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-label text-pretty wrap-break-word text-ink">
            {line.description}
          </span>
          <span className="block text-label text-ink-3">
            {BASIS[line.basis]} · <span className="tabular-nums">{when(line.updatedAt, now)}</span>
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn('size-4 shrink-0 text-ink-3', expanded && 'rotate-180')}
        />
      </button>
      {expanded && (
        <div id={panel} className="px-4 pb-3">
          <Opened entry={entry} send={send} />
        </div>
      )}
    </div>
  )
}

/** The open line's whole text, or the correction being written, or why neither is here. */
function Opened({
  entry,
  send,
}: {
  entry: remembering.Entry
  send: (event: remembering.Sent) => void
}) {
  return remembering.Entry.match(entry, {
    Closed: () => null,
    Vanished: () => null,
    Forgetting: () => null,
    Handed: () => null,
    Unforgotten: () => null,
    Opening: () => <Waiting />,
    Rereading: () => <Waiting />,
    Unopened: ({ line }) => (
      <div className="flex items-center gap-3">
        <p className="flex-1 text-label text-ink-3">That could not be opened.</p>
        <Button size="sm" variant="outline" onClick={() => send(remembering.events.Open({ line }))}>
          Try again
        </Button>
      </div>
    ),
    Open: ({ entry: open }) => <Whole entry={open} moved={false} send={send} />,
    Moved: ({ entry: open }) => <Whole entry={open} moved send={send} />,
    Editing: ({ entry: open }) => (
      <Correcting entry={open} saving={false} refused={false} send={send} />
    ),
    Saving: ({ entry: open }) => <Correcting entry={open} saving refused={false} send={send} />,
    Unsaved: ({ entry: open }) => <Correcting entry={open} saving={false} refused send={send} />,
  })
}

/** The still outline of a text on its way: two lines, so the row does not jump when it lands. */
function Waiting() {
  return (
    <div aria-busy className="flex flex-col gap-2 py-1">
      <span className="sr-only">One moment…</span>
      <i aria-hidden className="h-3 w-3/4 rounded-full bg-wash-hover" />
      <i aria-hidden className="h-3 w-1/2 rounded-full bg-wash-hover" />
    </div>
  )
}

/** An entry's whole text, with the two things the Person can do about it. */
function Whole({
  entry,
  moved,
  send,
}: {
  entry: SavedMemory
  moved: boolean
  send: (event: remembering.Sent) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {moved && (
        <p role="status" className="text-label text-ink-2">
          Vivid changed this while you had it open. This is what it says now.
        </p>
      )}
      <div className="rounded-control bg-surface-2 px-3 py-2.5 wrap-break-word *:text-label">
        <Markdown content={entry.body} />
      </div>
      <Sources entry={entry} />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => send(remembering.events.Edit())}>
          Correct
        </Button>
        <Button size="sm" variant="destructive" onClick={() => send(remembering.events.Forget())}>
          Forget
        </Button>
      </div>
    </div>
  )
}

/**
 * Where an entry came from: the Person's message or the conversation it was written in, each a
 * way into that Thread, or what else wrote it. Its words come from `@vivid/state`, as the phone's.
 */
function Sources({ entry }: { entry: SavedMemory }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-label text-ink-3">Where this came from</span>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {remembering.sourcesOf(entry).map((source, index) => (
          <li key={index} className="text-label text-ink-2">
            {Option.match(source.thread, {
              onNone: () => source.words,
              onSome: (id) => (
                <Button
                  variant="link"
                  size="xs"
                  onClick={() => void router.navigate({ to: '/t/$id', params: { id } })}
                >
                  {source.words}
                </Button>
              ),
            })}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A correction being written: the sentence and the whole text, each as the entry has it until
 * the Person changes it. The words live here and stay while the correction is sent and if it is
 * refused; the field is drawn by this one element through all three states, so nothing is lost
 * between them. What the Person corrects is something they said.
 */
function Correcting({
  entry,
  saving,
  refused,
  send,
}: {
  entry: SavedMemory
  saving: boolean
  refused: boolean
  send: (event: remembering.Sent) => void
}) {
  const [sentence, setSentence] = useState(entry.description)
  const [body, setBody] = useState(entry.body)
  const said = sentence.trim()
  // Nothing to save until both say something, and something other than they did.
  const ready =
    said.length > 0 && body.trim().length > 0 && (said !== entry.description || body !== entry.body)
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready) return
        send(
          remembering.events.Save({
            change: {
              layer: entry.layer,
              file: entry.file,
              kind: entry.kind,
              description: said,
              body,
              basis: 'said',
              scope: entry.scope,
            },
          }),
        )
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-label text-ink-2">What Vivid remembers</span>
        {/* A sentence can run to 200 characters, so it wraps as it is written instead of
            scrolling sideways in a one-line field. */}
        <Textarea
          // Correcting was just asked for; the cursor belongs in the sentence being corrected.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={sentence}
          maxLength={SENTENCE_LIMIT}
          disabled={saving}
          aria-invalid={refused}
          onChange={(event) => setSentence(event.currentTarget.value)}
          className="min-h-0 resize-none"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-label text-ink-2">In full</span>
        <Textarea
          value={body}
          disabled={saving}
          aria-invalid={refused}
          onChange={(event) => setBody(event.currentTarget.value)}
          className="max-h-80"
        />
      </label>
      {refused && (
        <p role="alert" className="text-label text-danger">
          That correction could not be saved. What you wrote is still here.
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving || !ready}>
          {saving ? 'Saving…' : refused ? 'Try again' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={() => send(remembering.events.Cancel())}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** The way to the older lines, while there are any. */
function Older({
  older,
  send,
}: {
  older: remembering.Older
  send: (event: remembering.Sent) => void
}) {
  const ask = () => send(remembering.events.ShowOlder())
  return remembering.Older.match(older, {
    None: () => null,
    Resting: () => (
      <div className="flex justify-center px-4 py-2">
        <Button size="sm" variant="ghost" onClick={ask}>
          Show older
        </Button>
      </div>
    ),
    Paging: () => (
      <div className="flex justify-center px-4 py-2">
        <Button size="sm" variant="ghost" disabled aria-busy>
          Showing older…
        </Button>
      </div>
    ),
    Unpaged: () => (
      <div className="flex items-center justify-center gap-3 px-4 py-2">
        <p className="text-label text-ink-3">Older ones could not be loaded.</p>
        <Button size="sm" variant="ghost" onClick={ask}>
          Try again
        </Button>
      </div>
    ),
  })
}
