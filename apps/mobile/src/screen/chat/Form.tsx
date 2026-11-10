import type { InputRequest } from '@vivid/contracts'
import { asking, filling, form } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { ScrollView, View, type KeyboardTypeOptions } from 'react-native'
import type { SharedValue } from 'react-native-reanimated'
import { answerIntegration, useFilling } from '../../data/filling'
import { useLiveData } from '../../data/live'
import { Field, Label } from '../../ui/ui'
import { Answer, Answers } from '../feed/Decide'
import { Attached, Surface, useSlide, useTallest } from './Banner'
import { Body, Head, Rows, Under, type Reach } from './Choices'

/**
 * An Integration's question, asked mid-call, as one more of Vivid's questions on the phone: the
 * same banner over the composer (`Banner.tsx`), the same head and rows (`Choices.tsx`), and under
 * them the Feed card's two buttons (`feed/Decide.tsx`). It is the phone mockup the owner accepted
 * on 9 November 2026 (`u4-phone.html`: "those are questions, it's fine"), and the web draws the
 * same (`apps/web/src/screen/thread/Form.tsx`).
 *
 * The head is the Integration's message. Under it is one block per property of its form, in the
 * form's order (`form.entriesOf`, `@vivid/state`): a closed set is the question's rows, one or
 * several; yes or no is two rows; words and numbers are the phone's own field. Each block has its
 * title over it (none for a form of one choice, which the head already asks), "optional" beside an
 * optional one, and its help line under the title. What is wrong with a value is said under it
 * once the Person has changed it, and keeps Send off whether said or not.
 *
 * Skip answers `decline`; Send answers `accept` with every field that has a value, through
 * `AnswerIntegrationInput` (`filling`, `@vivid/state`). A refusal is said in the banner, under
 * the head, as a handoff's is (`Handoff.tsx`), since the question stays up until it is answered.
 */
export function Filled({
  request,
  leaving,
  dock,
  covered,
  onGone,
}: {
  request: InputRequest
  /** It is no longer the one that is up: the banner slides away and then says so (`onGone`). */
  leaving: boolean
  /** The measured height of the composer's dock, which the banner is anchored to. */
  dock: number
  covered: SharedValue<number>
  onGone: () => void
}) {
  const [open, setOpen] = useState(true)
  const tallest = useTallest(dock)
  const slide = useSlide(asking.standOf(leaving, !open), covered, onGone)
  const reading = useFilling()
  const refusal = filling.refusalFor(reading, request.id)
  const asked = form.formOf(request)
  if (Option.isNone(asked)) return null
  return (
    <Attached dock={dock} tallest={tallest} leaving={leaving} slide={slide}>
      <Surface tallest={tallest}>
        <Head
          words={asked.value.message}
          count={Option.none()}
          says={{
            hide: 'Hide the question and its fields',
            show: 'Show the question and its fields',
            place: '',
          }}
          open={open}
          disabled={leaving}
          onHeight={(height) => slide.head.set(height)}
          onToggle={() => setOpen(!open)}
        />
        <Body open={open}>
          <Under>
            {Option.isSome(refusal) && (
              <Label size="label" tone="status-danger" style={{ marginBottom: 8 }}>
                {refusal.value}
              </Label>
            )}
            <Fields
              request={request}
              asked={asked.value}
              reach={leaving || !open || filling.isHeld(reading, request.id) ? 'held' : 'pressable'}
              going={filling.goingOn(reading, request.id)}
            />
          </Under>
        </Body>
      </Surface>
    </Attached>
  )
}

/** The blocks, which scroll when the banner has reached its most height, and the two buttons. */
function Fields({
  request,
  asked,
  reach,
  going,
}: {
  request: InputRequest
  asked: form.IntegrationForm
  reach: Reach
  /** Which button's answer is on its way. */
  going: Option.Option<'Send' | 'Skip'>
}) {
  const data = useLiveData()
  // What the Person has given so far, and which fields they have changed: plain state, since
  // nothing waits on it until Send or Skip.
  const [entries, setEntries] = useState(() => form.entriesOf(asked))
  const [changed, setChanged] = useState<ReadonlySet<string>>(new Set())
  const content = form.contentOf(entries)
  const held = reach === 'held'
  const change = (key: string, next: ReadonlyArray<form.Entry>) => {
    setEntries(next)
    setChanged((before) => new Set(before).add(key))
  }
  const send = () => {
    if (held || Option.isNone(content)) return
    answerIntegration(data, {
      id: request.id,
      response: { action: 'accept', content: content.value },
    })
  }
  return (
    <View style={{ flexShrink: 1 }}>
      <ScrollView
        bounces={false}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={{ flexShrink: 1 }}
        contentContainerStyle={{ gap: 12, paddingTop: 2 }}
      >
        {entries.map((entry) => (
          <Block
            key={entry.key}
            entry={entry}
            titled={form.titled(entries)}
            reach={reach}
            said={changed.has(entry.key)}
            onPick={(value) => change(entry.key, form.pick(entries, entry.key, value))}
            onTurn={(on) => change(entry.key, form.turn(entries, entry.key, on))}
            onType={(words) => change(entry.key, form.type(entries, entry.key, words))}
            onSubmit={send}
          />
        ))}
      </ScrollView>
      <View style={{ paddingTop: 4 }}>
        <Answers>
          <Answer
            words={Option.contains(going, 'Skip') ? 'Skipping…' : 'Skip'}
            primary={false}
            held={held}
            onPress={() =>
              answerIntegration(data, { id: request.id, response: { action: 'decline' } })
            }
          />
          <Answer
            words={Option.contains(going, 'Send') ? 'Sending…' : 'Send'}
            primary
            held={held || Option.isNone(content)}
            onPress={send}
          />
        </Answers>
      </View>
    </View>
  )
}

/** One row as a block hands it to `Rows`: the option, how it stands, and what a press does. */
interface Shown {
  readonly option: { readonly label: string; readonly detail: string }
  readonly standing: asking.Standing
  readonly press: () => void
}

/** A closed set's rows (`Rows`, `Choices.tsx`), each standing open or chosen. */
const shownOf = (
  rows: ReadonlyArray<{
    readonly label: string
    readonly chosen: boolean
    readonly press: () => void
  }>,
): ReadonlyArray<Shown> =>
  rows.map((row) => ({
    option: { label: row.label, detail: '' },
    standing: asking.standingOf(row.chosen, false),
    press: row.press,
  }))

/**
 * One property of the form: its title and help, then its rows or its field, then what is wrong
 * with it once the Person has changed it (`said`).
 */
function Block({
  entry,
  titled,
  reach,
  said,
  onPick,
  onTurn,
  onType,
  onSubmit,
}: {
  entry: form.Entry
  titled: boolean
  reach: Reach
  said: boolean
  onPick: (value: string) => void
  onTurn: (on: boolean) => void
  onType: (words: string) => void
  onSubmit: () => void
}) {
  const problem = said ? form.problemOf(entry) : Option.none()
  const rows = form.Entry.$match(entry, {
    One: ({ choices, picked }) =>
      Option.some({
        several: false,
        shown: shownOf(
          choices.map((choice) => ({
            label: choice.label,
            chosen: Option.contains(picked, choice.value),
            press: () => onPick(choice.value),
          })),
        ),
      }),
    Several: ({ choices, picked }) =>
      Option.some({
        several: true,
        shown: shownOf(
          choices.map((choice) => ({
            label: choice.label,
            chosen: picked.includes(choice.value),
            press: () => onPick(choice.value),
          })),
        ),
      }),
    Toggle: ({ on }) =>
      Option.some({
        several: false,
        shown: shownOf(
          form.YES_NO.map((row) => ({
            label: row.label,
            chosen: Option.contains(on, row.on),
            press: () => onTurn(row.on),
          })),
        ),
      }),
    Text: () => Option.none(),
    Number: () => Option.none(),
  })
  return (
    <View>
      {titled && (
        <Label size="label" tone="ink-2" style={{ marginLeft: 4, marginBottom: 6 }}>
          {entry.title}
          {!entry.required && <Label tone="ink-3"> · optional</Label>}
        </Label>
      )}
      {Option.isSome(entry.help) && (
        <Label size="caption" tone="ink-3" style={{ marginLeft: 4, marginBottom: 6 }}>
          {entry.help.value}
        </Label>
      )}
      {Option.isSome(rows) ? (
        <Rows
          rows={rows.value.shown}
          several={rows.value.several}
          reach={reach}
          onPick={(row) => row.press()}
        />
      ) : (
        <Field
          accessibilityLabel={entry.title}
          accessibilityHint={Option.getOrUndefined(problem)}
          editable={reach === 'pressable'}
          value={wordsOf(entry)}
          keyboardType={keyboardOf(entry)}
          autoCapitalize={
            form.Entry.$is('Text')(entry) && Option.isNone(entry.format) ? 'sentences' : 'none'
          }
          autoCorrect={form.Entry.$is('Text')(entry) && Option.isNone(entry.format)}
          placeholder={Option.getOrUndefined(placeholderOf(entry))}
          returnKeyType="send"
          onChangeText={onType}
          onSubmitEditing={onSubmit}
          style={{ minHeight: 44, paddingVertical: 11, paddingHorizontal: 14, borderRadius: 12 }}
        />
      )}
      {Option.isSome(problem) && (
        <Label size="caption" tone="status-danger" style={{ marginLeft: 4, marginTop: 4 }}>
          {problem.value}
        </Label>
      )}
    </View>
  )
}

/** The words in a text or number entry; a closed set has none. */
const wordsOf = (entry: form.Entry): string =>
  form.Entry.$is('Text')(entry) || form.Entry.$is('Number')(entry) ? entry.words : ''

/** The keyboard a field offers, from what it holds. */
const keyboardOf = (entry: form.Entry): KeyboardTypeOptions => {
  if (form.Entry.$is('Number')(entry)) return entry.integer ? 'number-pad' : 'decimal-pad'
  if (!form.Entry.$is('Text')(entry)) return 'default'
  return Option.match(entry.format, {
    onNone: () => 'default',
    onSome: (format) => {
      switch (format) {
        case 'email':
          return 'email-address'
        case 'uri':
          return 'url'
        case 'date':
        case 'date-time':
          return 'numbers-and-punctuation'
      }
    },
  })
}

/** What a date field shows while empty, so its shape is known before anything is typed. */
const placeholderOf = (entry: form.Entry): Option.Option<string> => {
  if (!form.Entry.$is('Text')(entry)) return Option.none()
  return Option.flatMap(entry.format, (format) => {
    switch (format) {
      case 'date':
        return Option.some('YYYY-MM-DD')
      case 'date-time':
        return Option.some('YYYY-MM-DDTHH:MM')
      case 'email':
      case 'uri':
        return Option.none()
    }
  })
}
