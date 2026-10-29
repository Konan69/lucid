import {
  HandoffFormState,
  HandoffRequest,
  HandoffScreenState,
  type HandoffField,
  type HandoffFieldPurpose,
  type HandoffValue,
  type PersonId,
  type ThreadId,
} from '@vivid/contracts'
import { asking, handing } from '@vivid/state'
import { Array as Arr, Option, Redacted } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import type { SharedValue } from 'react-native-reanimated'
import { pressHandoff, useHanding } from '../../data/handing'
import { arrive, viewerOf } from '../../data/computer'
import { LiveState, useLive, useLiveData } from '../../data/live'
import { openWebLink } from '../../data/links'
import { useGo } from '../../workspace'
import { Button, Field, Label, Labelled } from '../../ui/ui'
import { Attached, Surface, useSlide, useTallest } from './Banner'
import { Body, Head, Under } from './Choices'
import { Words } from './Words'

/**
 * A step Vivid handed the Person on its Computer, as the phone draws it: Vivid's words in the
 * conversation (`Handed`), and while it waits on the Person a banner risen from behind the
 * composer (`Handing`), as a question's and an Approval's are (`Choices.tsx`, `Allow.tsx`). The
 * web draws the same step the same way (`apps/web/src/screen/thread/Handoff.tsx`); what each
 * decides about it is `handing` in `@vivid/state`.
 *
 * What is typed stays in the banner's fields until Fill is pressed, and then nowhere on the phone.
 * The step is finished on the Computer's screen (`onOpenScreen`, `screen/Chat.tsx`): the app's
 * own Computer screen when it can draw it, otherwise the web Thread with the screen beside it.
 */

/**
 * Where the step is finished. A Computer whose screen the app can draw (a viewer page) opens on
 * the app's Computer screen. A relayed screen only the web panel draws (`data/computer.ts`
 * `viewerOf`), so the web Thread opens in the phone's browser with the screen beside it
 * (`?screen=true`, `apps/web/src/routes/thread.tsx`), on the same server; the browser needs its
 * own sign-in there.
 */
export function useOpenScreen(thread: ThreadId) {
  const data = useLiveData()
  const go = useGo()
  const state = useLive(data.live.computer)
  return () => {
    const viewer = LiveState.$is('Ready')(state) ? viewerOf(state.value.computer) : Option.none()
    if (Option.isSome(viewer)) {
      arrive(data)
      go.navigate('Computer')
      return
    }
    void openWebLink(`${data.session.server}/t/${encodeURIComponent(thread)}?screen=true`)
  }
}

/** The keyboard and suggestions for a field. Never another app's or site's saved password. */
const keyboardOf = (purpose: HandoffFieldPurpose) => {
  switch (purpose) {
    case 'Code':
      return { textContentType: 'oneTimeCode', autoComplete: 'one-time-code', numeric: true } as const
    case 'CardNumber':
    case 'CardCode':
      return { textContentType: 'none', autoComplete: 'off', numeric: true } as const
    case 'Text':
    case 'Password':
    case 'CardExpiry':
      return { textContentType: 'none', autoComplete: 'off', numeric: false } as const
  }
}

/** What is typed in one field so far; a field not yet typed into holds no text. */
const typedIn = (values: ReadonlyMap<string, string>, field: HandoffField) =>
  Option.getOrElse(Option.fromUndefinedOr(values.get(field.id)), () => '')

/** The step in the conversation: Vivid's sentence, and what became of it in one quiet line. */
export function Handed({ handoff, me }: { handoff: HandoffRequest; me: PersonId }) {
  const theirs = handing.isOpen(handoff) && handoff.askedOf.id !== me
  const done = HandoffRequest.match(handoff, {
    Form: ({ state }) =>
      HandoffFormState.guards.Completed(state) ? Option.some(state.completedBy) : Option.none(),
    Screen: ({ state }) =>
      HandoffScreenState.guards.Completed(state) ? Option.some(state.completedBy) : Option.none(),
  })
  return (
    <View>
      <Words text={handoff.summary} />
      {theirs && (
        <Label size="label" tone="ink-2">
          Waiting on {handoff.askedOf.name}.
        </Label>
      )}
      {Option.isSome(done) && (
        <Label size="label" tone="ink-2">
          Done by {done.value.name}.
        </Label>
      )}
    </View>
  )
}

interface StepProps {
  readonly held: boolean
  readonly onOpenScreen: () => void
}

/** Finishing: the screen, then Vivid sent on; or the step withdrawn. */
function Finish({ handoff, held, onOpenScreen }: StepProps & { handoff: HandoffRequest }) {
  const data = useLiveData()
  return (
    <View style={{ gap: 8 }}>
      <Button kind="plain" label="Open the screen" disabled={held} onPress={onOpenScreen} />
      <Button
        kind="primary"
        label="Continue"
        disabled={held}
        onPress={() => pressHandoff(data, handing.Command.cases.Complete.make({ id: handoff.id }))}
      />
      <NotNow handoff={handoff} held={held} />
    </View>
  )
}

/** Withdraws the step: Vivid is not woken and the Computer is handed back. */
function NotNow({ handoff, held }: { handoff: HandoffRequest; held: boolean }) {
  const data = useLiveData()
  return (
    <Button
      kind="ghost"
      label="Not now"
      disabled={held}
      onPress={() => pressHandoff(data, handing.Command.cases.Withdraw.make({ id: handoff.id }))}
    />
  )
}

/** What the fill button says: typing now, again for fields not filled, or the first time. */
const fillWords = (filling: boolean, ready: boolean) => {
  if (filling) return 'Filling…'
  return ready ? 'Fill again' : 'Fill'
}

/** A form step: fill the fields, then finish on the screen. */
function Form({
  handoff,
  held,
  onOpenScreen,
}: StepProps & { handoff: typeof HandoffRequest.cases.Form.Type }) {
  const data = useLiveData()
  // Text in a field is plain state: nothing waits on it until Fill is pressed.
  const [values, setValues] = useState<ReadonlyMap<string, string>>(new Map())
  const toFill = handing.fieldsToFill(handoff.fields, handoff.state)
  const ready = HandoffFormState.guards.Ready(handoff.state)
  const receipts = HandoffFormState.guards.Ready(handoff.state) ? handoff.state.fields : []
  const filling = HandoffFormState.guards.Applying(handoff.state)
  const typed = toFill.flatMap((field): ReadonlyArray<HandoffValue> => {
    const value = typedIn(values, field)
    return value === '' ? [] : [{ fieldId: field.id, value: Redacted.make(value) }]
  })
  // The first fill covers every field; a later one any of those not filled.
  const complete = ready ? typed.length > 0 : typed.length === toFill.length
  const fill = () => {
    if (!Arr.isReadonlyArrayNonEmpty(typed) || !complete) return
    pressHandoff(data, handing.Command.cases.Fill.make({ request: { id: handoff.id, values: typed } }))
    // Sent: what was typed is not kept here a moment longer.
    setValues(new Map())
  }
  return (
    <View style={{ gap: 12 }}>
      {handoff.fields.map((field) =>
          Option.match(
            Arr.findFirst(receipts, (receipt) => receipt.fieldId === field.id),
            {
              onNone: () => null,
              onSome: (receipt) => (
                <Label key={field.id} size="label" tone="ink-2">
                  {field.label}: {handing.resultWords(receipt.result)}
                </Label>
              ),
            },
          ),
        )}
      {toFill.length > 0 && (
        <Label size="label" tone="ink-3">
          Typed into the page on Vivid’s computer. Vivid never sees what you type.
        </Label>
      )}
      {toFill.map((field) => {
        const keyboard = keyboardOf(field.purpose)
        return (
          <Labelled key={field.id} label={field.label}>
            <Field
              accessibilityLabel={field.label}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete={keyboard.autoComplete}
              textContentType={keyboard.textContentType}
              importantForAutofill="no"
              keyboardType={keyboard.numeric ? 'number-pad' : 'default'}
              editable={!held && !filling}
              value={typedIn(values, field)}
              onChangeText={(text) => setValues((before) => new Map(before).set(field.id, text))}
              onSubmitEditing={fill}
            />
          </Labelled>
        )
      })}
      {toFill.length > 0 && (
        <Button
          kind={ready ? 'plain' : 'primary'}
          label={fillWords(filling, ready)}
          disabled={held || filling || !complete}
          onPress={fill}
        />
      )}
      {ready && (
        <Label size="label" tone="ink-2">
          Now finish on the screen: check the page and press its button there. Then continue.
        </Label>
      )}
      {ready ? (
        <Finish handoff={handoff} held={held} onOpenScreen={onOpenScreen} />
      ) : (
        <NotNow handoff={handoff} held={held} />
      )}
    </View>
  )
}

/** A step on the screen: take it, do it there, then send Vivid on. */
function Screen({
  handoff,
  held,
  onOpenScreen,
}: StepProps & { handoff: typeof HandoffRequest.cases.Screen.Type }) {
  const data = useLiveData()
  return HandoffScreenState.match(handoff.state, {
    Waiting: () => (
      <View style={{ gap: 8 }}>
        <Button
          kind="primary"
          label="Take the screen"
          disabled={held}
          onPress={() => {
            pressHandoff(data, handing.Command.cases.Begin.make({ id: handoff.id }))
            onOpenScreen()
          }}
        />
        <NotNow handoff={handoff} held={held} />
      </View>
    ),
    Ready: () => (
      <View style={{ gap: 12 }}>
        <Label size="label" tone="ink-2">
          Do the step on the screen. Then continue.
        </Label>
        <Finish handoff={handoff} held={held} onOpenScreen={onOpenScreen} />
      </View>
    ),
    Completed: () => null,
    Withdrawn: () => null,
  })
}

/**
 * The banner over the composer for the step waiting on this Person (`handing.handoffUp`), on the
 * banner every ask shares (`Banner.tsx`) with a question's head (`Choices.tsx`). A call that did
 * not go through is said in the banner, under the head, since the step stays up until it is done.
 */
export function Handing({
  handoff,
  dock,
  covered,
  onOpenScreen,
}: {
  handoff: HandoffRequest
  /** The measured height of the composer's dock, which the banner is anchored to. */
  dock: number
  covered: SharedValue<number>
  onOpenScreen: () => void
}) {
  const [open, setOpen] = useState(true)
  const tallest = useTallest(dock)
  const slide = useSlide(asking.standOf(false, !open), covered, () => undefined)
  const reading = useHanding()
  const held = handing.isWaiting(reading)
  const refusal = handing.refusalFor(reading, handoff.id)
  return (
    <Attached dock={dock} tallest={tallest} leaving={false} slide={slide}>
      <Surface tallest={tallest}>
        <Head
          words={handoff.summary}
          count={Option.none()}
          says={{ hide: 'Hide the step', show: 'Show the step', place: '' }}
          open={open}
          disabled={false}
          onHeight={(height) => slide.head.set(height)}
          onToggle={() => setOpen(!open)}
        />
        <Body open={open}>
          <Under>
            <View style={{ gap: 12 }}>
              {Option.isSome(refusal) && (
                <Label size="label" tone="status-danger">
                  {refusal.value}
                </Label>
              )}
              {HandoffRequest.match(handoff, {
                Form: (form) => (
                  <Form key={form.id} handoff={form} held={held} onOpenScreen={onOpenScreen} />
                ),
                Screen: (screen) => (
                  <Screen handoff={screen} held={held} onOpenScreen={onOpenScreen} />
                ),
              })}
            </View>
          </Under>
        </Body>
      </Surface>
    </Attached>
  )
}
