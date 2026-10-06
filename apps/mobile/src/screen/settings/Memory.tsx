import {
  MemoryScope,
  type Memory as MemoryRecord,
  type MemoryId,
  type MemoryListResponse,
} from '@vivid/contracts'
import { Data, Option, Result } from 'effect'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { warn } from '../../data/haptics'
import { LiveState, useLive, useLiveData } from '../../data/live'
import { Screen } from '../../ui/Screen'
import { Row, Section } from '../../ui/List'
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

/** The most a memory's sentence can hold, as `CorrectMemoryRequest` in the contract checks it. */
const SENTENCE_LIMIT = 1000

/**
 * Where a memory came from and who can have it recalled, in the web app's words
 * (`apps/web/src/screen/settings/Memory.tsx`): a new scope fails to compile here.
 */
const where = (memory: MemoryRecord) =>
  MemoryScope.match(memory.scope, {
    Person: () => 'About you',
    Company: () => 'The whole company knows',
    Thread: ({ title }) => `From “${title}”`,
  })

/** The line under a memory: where it came from, and the Person it was learned from. */
const provenance = (memory: MemoryRecord) =>
  `${where(memory)} · learned from ${memory.learnedFrom.name}`

/** The list as it stands once a correction is taken: the same memory, in the new words. */
const corrected =
  (id: MemoryId, content: string) =>
  (known: MemoryListResponse): MemoryListResponse => ({
    brief: known.brief,
    memories: known.memories.map((memory) => (memory.id === id ? { ...memory, content } : memory)),
  })

/** The list as it stands once a memory is forgotten. The brief is rebuilt by the server later. */
const forgotten =
  (id: MemoryId) =>
  (known: MemoryListResponse): MemoryListResponse => ({
    brief: known.brief,
    memories: known.memories.filter((memory) => memory.id !== id),
  })

/**
 * What Vivid knows. Everything it has kept is listed in plain sentences, with where it learned
 * each one, and the Person can correct or remove any of them: memory they cannot see and change
 * would not be theirs. The page at the top is what Vivid reads before each response.
 *
 * It is the phone's half of the web app's section of the same name, on the same live query. A
 * memory is opened to be changed, the way a Member is in People, because a row on a phone has
 * no room for two buttons beside a sentence.
 */
export function Memory() {
  const data = useLiveData()
  const memory = useLive(data.live.memory)
  const [open, setOpen] = useState<Option.Option<MemoryRecord>>(Option.none())
  // A memory is taken off the list the moment it is forgotten and its sheet is already closed, so
  // a refusal has nowhere to be said but here, above the list the memory came back to.
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())

  return (
    <Screen>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, styles.column]}
      >
        <Shown
          state={memory}
          refused={refused}
          onOpen={(item) => {
            setRefused(Option.none())
            setOpen(Option.some(item))
          }}
        />
      </ScrollView>
      {Option.isSome(open) && (
        <Kept memory={open.value} onClose={() => setOpen(Option.none())} onRefused={setRefused} />
      )}
    </Screen>
  )
}

/**
 * The live query's three states, kept apart. This screen does not use `ui/Live.tsx` because its
 * failure is not the server's sentence: every Vivid has its memory, so a failure here is memory
 * not answering for a while. That is nothing the Person did or can fix, so it is said plainly,
 * with what stays true (nothing is lost), and not painted as a refusal.
 */
function Shown({
  state,
  refused,
  onOpen,
}: {
  state: LiveState<MemoryListResponse>
  refused: Option.Option<string>
  onOpen: (memory: MemoryRecord) => void
}) {
  return LiveState.$match(state, {
    Loading: () => <Skeleton rows={4} />,
    Failed: () => (
      <Card>
        <Label size="label" tone="ink-2">
          Vivid’s memory is not answering right now. Nothing is lost: what Vivid knows is kept, and
          it will be here again as soon as memory answers.
        </Label>
      </Card>
    ),
    Ready: ({ value }) => <Known known={value} refused={refused} onOpen={onOpen} />,
  })
}

/** Prose inside a Section. The brief is a page to read, not a row to press, so it runs on. */
function Passage({ children }: { children: string }) {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
      <Label selectable size="label" tone="ink-2">
        {children}
      </Label>
    </View>
  )
}

/** The brief Vivid reads before it answers, then every memory behind it, each one openable. */
function Known({
  known,
  refused,
  onOpen,
}: {
  known: MemoryListResponse
  refused: Option.Option<string>
  onOpen: (memory: MemoryRecord) => void
}) {
  const brief = known.brief.text.trim()
  return (
    <>
      <Section title="In short" detail="What Vivid reads before it answers you.">
        <Passage>
          {brief.length === 0
            ? 'Nothing yet. As you work together, Vivid keeps what will matter later.'
            : brief}
        </Passage>
      </Section>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Section
        title="Everything it has kept"
        detail="Correct what is wrong. Remove what it should not keep."
      >
        {known.memories.length === 0 && <Row title="Nothing kept yet" />}
        {known.memories.map((item) => (
          <Row
            key={item.id}
            wrap
            title={item.content}
            detail={provenance(item)}
            onPress={() => onOpen(item)}
          />
        ))}
      </Section>
    </>
  )
}

/** How the last attempt to save a correction went. */
type Saving = Data.TaggedEnum<{ Idle: {}; Asking: {}; Refused: {} }>
const Saving = Data.taggedEnum<Saving>()

/**
 * One memory, opened: its sentence in a field to correct, and the way to have Vivid forget it.
 *
 * The words being typed live here until the server takes them. A refused correction leaves the
 * sheet open with the words still in the field and says so; an accepted one closes it. Forgetting
 * asks first, then closes the sheet at once: the memory leaves the list as the question is
 * answered, and comes back with a sentence above the list if the server will not forget it.
 */
function Kept({
  memory,
  onClose,
  onRefused,
}: {
  memory: MemoryRecord
  onClose: () => void
  onRefused: (refusal: Option.Option<string>) => void
}) {
  const data = useLiveData()
  const [draft, setDraft] = useState(memory.content)
  const [saving, setSaving] = useState<Saving>(Saving.Idle())
  const content = draft.trim()
  const asking = Saving.$is('Asking')(saving)

  async function correct() {
    setSaving(Saving.Asking())
    const saved = await data.change(
      (client) => client.CorrectMemory({ id: memory.id, content }),
      () => data.live.memory.expect(corrected(memory.id, content)),
    )
    if (Result.isSuccess(saved)) onClose()
    else setSaving(Saving.Refused())
  }

  async function forget() {
    warn()
    onClose()
    const result = await data.change(
      (client) => client.ForgetMemory({ id: memory.id }),
      () => data.live.memory.expect(forgotten(memory.id)),
    )
    onRefused(
      Result.isFailure(result)
        ? Option.some('That could not be forgotten, so it is back in the list.')
        : Option.none(),
    )
  }

  const askToForget = () =>
    confirmDestructive({
      title: 'Forget this?',
      detail: 'Vivid stops using it from now on. This cannot be undone.',
      action: 'Forget',
      onConfirm: () => void forget(),
    })

  return (
    <Sheet title="What Vivid kept" detail={provenance(memory)} onClose={onClose}>
      <Labelled label="What Vivid should know">
        <Field
          accessibilityLabel="What Vivid should know"
          value={draft}
          maxLength={SENTENCE_LIMIT}
          multiline
          onChangeText={(next) => {
            setDraft(next)
            // The refusal was about the words as they were; new words are a new attempt. A
            // correction still on its way is left alone, so it cannot be sent twice.
            if (Saving.$is('Refused')(saving)) setSaving(Saving.Idle())
          }}
          style={{ minHeight: 96, textAlignVertical: 'top' }}
        />
      </Labelled>
      {Saving.$is('Refused')(saving) && (
        <Notice message="That correction could not be saved. What you wrote is still here." />
      )}
      <Button
        kind="primary"
        label={Saving.$match(saving, {
          Idle: () => 'Save correction',
          Asking: () => 'One moment…',
          Refused: () => 'Try again',
        })}
        // Nothing to save until the sentence says something, and something other than it did.
        disabled={asking || content.length === 0 || content === memory.content}
        onPress={() => void correct()}
      />
      <Button kind="danger" label="Forget this" disabled={asking} onPress={askToForget} />
    </Sheet>
  )
}
