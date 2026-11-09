import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { VividRpcClient } from '@vivid/client-runtime'
import {
  MemoryExport,
  type MemoryForgetId,
  type MemoryLine,
  type SavedMemory,
} from '@vivid/contracts'
import { LiveState, makeWhen, remembering, thisReader } from '@vivid/state'
import { Effect, Option, Result, Schema } from 'effect'
import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { useState, type ReactNode } from 'react'
import { Alert, ScrollView, View } from 'react-native'
import { start } from '../../data/app'
import { openWebLink } from '../../data/links'
import { warn } from '../../data/haptics'
import { useLive, useLiveData } from '../../data/live'
import { useOpenThread } from '../../workspace'
import { Row, Section } from '../../ui/List'
import { Prose } from '../../ui/Prose'
import { Screen } from '../../ui/Screen'
import { Sheet } from '../../ui/Sheet'
import {
  Button,
  Card,
  confirmDestructive,
  Field,
  Label,
  Labelled,
  Notice,
  Skeleton,
  styles,
} from '../../ui/ui'

const when = makeWhen(thisReader())

/** The most a remembered sentence can hold, as `MemoryEntry` in the contract checks it. */
const SENTENCE_LIMIT = 200

/** Whether Vivid was told or worked it out, in the web app's words (`settings/Memory.tsx`). */
const BASIS = { said: 'You said', guessed: 'Vivid’s guess' } as const
/** What a Dreamer note says in place of who said it, as on the web (`settings/Memory.tsx`). */
const FOUND = 'Vivid looked into it'

type Send = (event: remembering.Sent) => void

/** The line under a remembered sentence: who it came from and when it last changed. */
const provenance = (line: Pick<MemoryLine, 'layer' | 'basis' | 'updatedAt'>, now: number) =>
  `${line.layer === 'dreams' ? FOUND : BASIS[line.basis]} · ${when(line.updatedAt, now)}`

/**
 * What Vivid remembers about the Person, the phone's half of the web app's section of the same
 * name and on the same machine (`remembering` in `@vivid/state`): the pages Vivid keeps standing,
 * each whole, then the newest things it remembers, one row each. It is the memory Vivid reads
 * before every response, read from the Person's cell each time this screen is opened.
 *
 * A row opens in a sheet, the way a Member is opened in People, because a row on a phone has no
 * room for its whole text and two actions beside it.
 */
export function Memory() {
  const data = useLiveData()
  const [visit] = useState(data.memory.begin)
  const reading = useAtomValue(visit.reading)
  const send = useAtomSet(visit.send)
  const [opened] = useState(() => Date.now())
  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, styles.column]}
      >
        <Page reading={reading} send={send} now={opened} />
        <Download />
      </ScrollView>
      {remembering.Remembering.guards.Shown(reading) && (
        <Opened entry={reading.entry} send={send} now={opened} />
      )}
    </Screen>
  )
}

type ShownReading = typeof remembering.Remembering.cases.Shown.Type

/** The visit's reading: still on its way, refused, or shown. */
function Page({
  reading,
  send,
  now,
}: {
  reading: remembering.Remembering
  send: Send
  now: number
}) {
  return remembering.Remembering.match(reading, {
    Reading: () => <Skeleton rows={4} />,
    Unread: () => (
      <Card>
        <Label selectable size="label" tone="ink-2">
          Unable to load what Vivid remembers right now.
        </Label>
        <Button label="Try again" onPress={() => send(remembering.events.Retry())} />
      </Card>
    ),
    Shown: (shown) => <Shown shown={shown} send={send} now={now} />,
  })
}

/**
 * The row under the list, when there is anything older. A function and not a component: a
 * Section draws a separator above every row it is given, including one that draws nothing.
 */
const olderRow = (older: remembering.Older, send: Send) =>
  remembering.Older.match(older, {
    None: () => null,
    Resting: () => <Row title="Show older" onPress={() => send(remembering.events.ShowOlder())} />,
    Paging: () => <Row title="Showing older…" />,
    Unpaged: () => (
      <Row
        wrap
        title="Older ones could not be loaded"
        detail="Tap to try again."
        onPress={() => send(remembering.events.ShowOlder())}
      />
    ),
  })

/** The standing pages, then the rows, then the way to older ones. */
function Shown({ shown, send, now }: { shown: ShownReading; send: Send; now: number }) {
  const page = (layer: SavedMemory['layer']) =>
    shown.standing.filter((standing) => standing.layer === layer)
  // A row being forgotten leaves the list at once; it comes back if the cell refuses.
  const lines = remembering.Entry.guards.Forgetting(shown.entry)
    ? shown.lines.filter((line) => !remembering.isAt(line, remembering.openAddress(shown.entry)))
    : shown.lines
  // What the Dreamer found is listed on its own, above what Vivid remembers.
  const dreams = remembering.found(lines)
  const others = remembering.kept(lines)
  return (
    <>
      <Pages title="About you" pages={page('person')} />
      <Pages title="How Vivid reaches you" pages={page('attention')} />
      <Pages title="Vivid" pages={[...page('self'), ...page('soul')]} />
      {remembering.Entry.guards.Unforgotten(shown.entry) && (
        <Notice message="Couldn’t forget that, so it’s back in the list. Try again." />
      )}
      {remembering.Entry.guards.Vanished(shown.entry) && (
        <Notice message="Vivid no longer remembers that, so it has left the list." />
      )}
      {remembering.Entry.guards.Handed(shown.entry) && <Forgotten id={shown.entry.forget} />}
      {dreams.length > 0 && (
        <Section title="What Vivid found">
          {dreams.map((line) => (
            <Row
              key={`${line.layer}/${line.file}`}
              wrap
              title={line.description}
              detail={provenance(line, now)}
              onPress={() => send(remembering.events.Open({ line }))}
            />
          ))}
        </Section>
      )}
      <Section title="What Vivid remembers">
        {others.length === 0 && (
          <Row wrap title="When you tell Vivid something that matters later, it shows up here." />
        )}
        {others.map((line) => (
          <Row
            key={`${line.layer}/${line.file}`}
            wrap
            title={line.description}
            detail={provenance(line, now)}
            onPress={() => send(remembering.events.Open({ line }))}
          />
        ))}
        {olderRow(shown.older, send)}
      </Section>
    </>
  )
}

/**
 * Where a forget the Person pressed stands, read live until Vivid has carried it out across what
 * it remembers, its Watches and the work queued with it. The words are the web app's
 * (`remembering.forgetWords`); Forgotten is said only once nothing can bring it back.
 */
function Forgotten({ id }: { id: MemoryForgetId }) {
  const data = useLiveData()
  const receipt = useLive(data.memory.forgets.get(id))
  const words = LiveState.$match(receipt, {
    Loading: () => remembering.forgetWords(remembering.pendingForget(id)),
    Ready: ({ value }) => remembering.forgetWords(value),
    Failed: () => ({ headline: 'Unable to tell how forgetting it went right now.', lines: [] }),
  })
  return (
    <Section title="Forgetting">
      <Row wrap title={words.headline} />
      {words.lines.map((line) => (
        <Row key={line} wrap title={line} />
      ))}
    </Section>
  )
}

/** Prose inside a Section. A page is something to read, not a row to press, so it runs on. */
function Pages({ title, pages }: { title: string; pages: ReadonlyArray<SavedMemory> }) {
  if (pages.length === 0) return null
  return (
    <Section title={title}>
      {pages.map((standing) => (
        <View key={standing.file} style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
          <Whole text={standing.body} />
        </View>
      ))}
    </Section>
  )
}

/** An entry's whole text, in the reply's Markdown. */
function Whole({ text }: { text: string }) {
  return (
    <Prose
      text={text}
      plain={text}
      fresh={false}
      marks={[]}
      onLink={(url) => void openWebLink(url)}
    />
  )
}

/**
 * The entry the Person has open, in a sheet: its whole text with Correct and Forget, or the
 * correction being written. The sheet is up from the press until the entry is put away; while
 * it is being forgotten it is down, and the row is gone from the list behind it.
 */
function Opened({ entry, send, now }: { entry: remembering.Entry; send: Send; now: number }) {
  const close = () => send(remembering.events.Close())
  const sheet = (line: Pick<MemoryLine, 'layer' | 'basis' | 'updatedAt'>, body: ReactNode) => (
    <Sheet title="Remembered" detail={provenance(line, now)} onClose={close}>
      {body}
    </Sheet>
  )
  return remembering.Entry.match(entry, {
    Closed: () => null,
    Vanished: () => null,
    Forgetting: () => null,
    Handed: () => null,
    Unforgotten: () => null,
    Opening: ({ line }) => sheet(line, <Skeleton rows={2} />),
    Rereading: ({ entry: open }) => sheet(open, <Skeleton rows={2} />),
    Unopened: ({ line }) =>
      sheet(
        line,
        <>
          <Notice message="That could not be opened." />
          <Button label="Try again" onPress={() => send(remembering.events.Open({ line }))} />
        </>,
      ),
    Open: ({ entry: open }) => sheet(open, <Kept entry={open} moved={false} send={send} />),
    Moved: ({ entry: open }) => sheet(open, <Kept entry={open} moved send={send} />),
    Editing: ({ entry: open }) =>
      sheet(open, <Correcting entry={open} saving={false} refused={false} send={send} />),
    Saving: ({ entry: open }) =>
      sheet(open, <Correcting entry={open} saving refused={false} send={send} />),
    Unsaved: ({ entry: open }) =>
      sheet(open, <Correcting entry={open} saving={false} refused send={send} />),
  })
}

/** One entry, opened: its whole text, and the two things the Person can do about it. */
function Kept({ entry, moved, send }: { entry: SavedMemory; moved: boolean; send: Send }) {
  const askToForget = () =>
    confirmDestructive({
      title: 'Forget this?',
      detail:
        'Vivid stops remembering it, and stops what it set up around it. This cannot be undone.',
      action: 'Forget',
      onConfirm: () => {
        warn()
        send(remembering.events.Forget())
      },
    })
  return (
    <>
      {moved && (
        <Label size="label" tone="ink-2" accessibilityLiveRegion="polite">
          Vivid changed this while you had it open. This is what it says now.
        </Label>
      )}
      <Label selectable size="label" style={{ fontWeight: '600' }}>
        {entry.description}
      </Label>
      <Whole text={entry.body} />
      <Sources entry={entry} send={send} />
      <Button label="Correct" onPress={() => send(remembering.events.Edit())} />
      <Button kind="danger" label="Forget this" onPress={askToForget} />
    </>
  )
}

/**
 * Where an entry came from: the Person's message or the conversation it was written in, each
 * opening that Thread (the sheet is put away first), or what else wrote it.
 */
function Sources({ entry, send }: { entry: SavedMemory; send: Send }) {
  const openThread = useOpenThread()
  return (
    <Section title="Where this came from">
      {remembering.sourcesOf(entry).map((source, index) =>
        Option.match(source.thread, {
          onNone: () => <Row key={index} wrap title={source.words} />,
          onSome: (id) => (
            <Row
              key={index}
              wrap
              title={source.words}
              onPress={() => {
                send(remembering.events.Close())
                openThread(id)
              }}
            />
          ),
        }),
      )}
    </Section>
  )
}

/**
 * A correction being written: the sentence and the whole text, each as the entry has it until
 * the Person changes it. The words live here and stay while the correction is sent and if it is
 * refused: the same element draws all three states, so nothing typed is lost between them. What
 * the Person corrects is something they said.
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
  send: Send
}) {
  const [sentence, setSentence] = useState(entry.description)
  const [body, setBody] = useState(entry.body)
  const said = sentence.trim()
  // Nothing to save until both say something, and something other than they did.
  const ready =
    said.length > 0 && body.trim().length > 0 && (said !== entry.description || body !== entry.body)
  const save = () =>
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
  return (
    <>
      <Labelled label="What Vivid remembers">
        <Field
          accessibilityLabel="What Vivid remembers"
          value={sentence}
          maxLength={SENTENCE_LIMIT}
          multiline
          editable={!saving}
          onChangeText={setSentence}
          style={{ minHeight: 72, textAlignVertical: 'top' }}
        />
      </Labelled>
      <Labelled label="In full">
        <Field
          accessibilityLabel="In full"
          value={body}
          multiline
          editable={!saving}
          onChangeText={setBody}
          style={{ minHeight: 160, textAlignVertical: 'top' }}
        />
      </Labelled>
      {refused && (
        <Notice message="That correction could not be saved. What you wrote is still here." />
      )}
      <Button
        kind="primary"
        label={saving ? 'Saving…' : refused ? 'Try again' : 'Save correction'}
        disabled={saving || !ready}
        onPress={save}
      />
      <Button
        kind="ghost"
        label="Cancel"
        disabled={saving}
        onPress={() => send(remembering.events.Cancel())}
      />
    </>
  )
}

/** The download could not be made or handed to the share sheet. */
class Unshared extends Schema.TaggedError<Unshared>()(
  'Unshared',
  {},
  { title: 'The memory file could not be shared' },
) {}

/**
 * Everything the Person's memory holds, read whole on the server (`ExportMemory`) and written as
 * the contract encodes it, so the file is the same JSON the server keeps. The web saves the same
 * file (`apps/web/src/screen/settings/Memory.tsx`).
 */
const encodeExport = Schema.encodeEffect(MemoryExport)
const exported = Effect.fn('Memory.exported')(function* () {
  const client = yield* VividRpcClient
  return yield* encodeExport(yield* client.ExportMemory())
})

/**
 * Writes the file to the app's cache and hands it to the share sheet, which is how a phone saves
 * a file to Files or sends it on, as an opened PDF is (`data/documents.ts`).
 */
const share = Effect.fn('Memory.share')(function* (file: typeof MemoryExport.Encoded) {
  const day = new Date(file.exportedAt).toISOString().slice(0, 10)
  const written = yield* Effect.try({
    try: () => {
      const target = new File(Paths.cache, `vivid-memory-${day}.json`)
      if (target.exists) target.delete()
      target.create()
      target.write(JSON.stringify(file, null, 2))
      return target
    },
    catch: () => new Unshared({}),
  })
  return yield* Effect.tryPromise({
    try: () => Sharing.shareAsync(written.uri, { mimeType: 'application/json' }),
    catch: () => new Unshared({}),
  })
})

/** The way to take a copy of everything Vivid remembers about the Person. */
function Download() {
  const data = useLiveData()
  const download = () =>
    start(
      Effect.gen(function* () {
        const file = yield* data.running(exported())
        const shared = Result.isSuccess(file)
          ? yield* Effect.result(share(file.success))
          : Result.fail(new Unshared({}))
        if (Result.isFailure(shared))
          Alert.alert('Your memory could not be downloaded', 'Try again.')
      }),
    )
  return (
    <Section title="Your copy">
      <Row
        title="Download everything Vivid remembers"
        detail="Every page and line, whole, as one file you can keep."
        onPress={() => void download()}
      />
    </Section>
  )
}
