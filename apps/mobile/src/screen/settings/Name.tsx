import { PERSON_NAME_MAX } from '@vivid/contracts'
import { naming } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { closeNaming, saveName, useNaming } from '../../data/name'
import { useLiveData } from '../../data/live'
import { Sheet } from '../../ui/Sheet'
import { Button, Field, Labelled, Notice } from '../../ui/ui'

/**
 * The sheet a Person changes their own name in, drawn as `NameSheet` draws every one-line sheet
 * (`ui/Sheet.tsx`): the field, a refusal when there is one, and one wide action.
 *
 * It is not `NameSheet` itself because whether it is open, saving or refused belongs to the
 * session's `naming` machine (`data/name.ts`), not to the sheet: the sheet is drawn while the
 * machine is open, closing it is the machine's `Close`, and the machine closes it when the server
 * has taken the name. What is typed stays the field's own.
 */
export function Name({ current }: { current: string }) {
  const data = useLiveData()
  const reading = useNaming()
  const [written, setWritten] = useState(current)
  const name = naming.typedName(written)
  // Said only once something is typed: an emptied field is not yet a mistake.
  const invalid = written.trim().length > 0 && Option.isNone(name)
  const refusal = naming.refusalOf(reading)
  const waiting = naming.isWaiting(reading)
  const save = () => {
    if (Option.isSome(name) && !waiting) saveName(data, name.value)
  }
  return (
    <Sheet
      title="Your name"
      detail="What Vivid calls you, and what others see beside your messages."
      onClose={() => closeNaming(data)}
    >
      <Labelled label="Name">
        <Field
          autoFocus
          accessibilityLabel="Name"
          value={written}
          placeholder="Your name"
          maxLength={PERSON_NAME_MAX}
          autoComplete="name"
          textContentType="name"
          autoCapitalize="words"
          returnKeyType="done"
          editable={!waiting}
          onChangeText={setWritten}
          onSubmitEditing={save}
        />
      </Labelled>
      {invalid && <Notice message="Use one line, without backslashes." />}
      {Option.isSome(refusal) && <Notice message={refusal.value} />}
      <Button
        morph
        kind="primary"
        label={naming.Reading.guards.Saving(reading) ? 'One moment…' : 'Save'}
        disabled={waiting || Option.isNone(name) || name.value === current}
        onPress={save}
      />
    </Sheet>
  )
}
