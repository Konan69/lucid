import { PERSON_NAME_MAX } from '@vivid/contracts'
import { naming } from '@vivid/state'
import { Option } from 'effect'
import { useId, useState } from 'react'
import { closeNaming, openNaming, saveName, useNaming } from '../../data/name'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '../../ui/popover'
import { Row } from './Parts'

/**
 * The Person's name, and the small form they change it in. It is what Vivid calls them in a
 * Thread and what other people see beside their Messages.
 *
 * The form is the same small popover the Integration name uses (`integration/Name.tsx`). Whether
 * it is open, saving or refused is the `naming` machine's (`data/name.ts`), not this component's:
 * pressing Change or closing it is an event, and the machine closes the form when the server has
 * taken the name.
 */
export function Name({ current }: { current: string }) {
  const reading = useNaming()
  return (
    <Row label="Name" detail="What Vivid calls you, and what others see beside your messages.">
      <Popover
        open={naming.isOpen(reading)}
        onOpenChange={(open) => (open ? openNaming() : closeNaming())}
      >
        <PopoverTrigger render={<Button variant="outline" size="sm" />}>Change</PopoverTrigger>
        <PopoverContent align="end">
          <NameForm current={current} reading={reading} />
        </PopoverContent>
      </Popover>
    </Row>
  )
}

/**
 * The form itself. It is mounted with the popup, so the field starts from the name the Person has
 * now each time it opens. A name that is not one the server takes is said beside the field and
 * never sent.
 */
function NameForm({ current, reading }: { current: string; reading: naming.Reading }) {
  const [written, setWritten] = useState(current)
  const field = useId()
  const name = naming.typedName(written)
  // Said only once something is typed: an emptied field is not yet a mistake.
  const invalid = written.trim().length > 0 && Option.isNone(name)
  const refusal = naming.refusalOf(reading)
  const waiting = naming.isWaiting(reading)
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (Option.isSome(name)) saveName(name.value)
      }}
    >
      <PopoverHeader>
        <PopoverTitle render={<label htmlFor={field} />}>Your name</PopoverTitle>
        <PopoverDescription>Vivid uses it from your next message.</PopoverDescription>
      </PopoverHeader>
      <Input
        id={field}
        compact
        // Focus lands in the field: the form was opened to type a name.
        autoFocus
        value={written}
        onChange={(event) => setWritten(event.currentTarget.value)}
        maxLength={PERSON_NAME_MAX}
        autoComplete="name"
        autoCapitalize="words"
        spellCheck={false}
        disabled={waiting}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${field}-invalid` : undefined}
      />
      {invalid && (
        <p id={`${field}-invalid`} role="alert" className="text-meta font-meta text-danger">
          Use one line, without backslashes.
        </p>
      )}
      {Option.isSome(refusal) && (
        <p role="alert" className="text-meta font-meta text-danger">
          {refusal.value}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          disabled={waiting || Option.isNone(name) || name.value === current}
        >
          {naming.Reading.guards.Saving(reading) ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  )
}
