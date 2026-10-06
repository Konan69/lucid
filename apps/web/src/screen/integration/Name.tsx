import { ACCOUNT_NAME_MAX, type AccountName, type Connection } from '@vivid/contracts'
import { nameTaken, typedAccountName } from '@vivid/state'
import { Option } from 'effect'
import { useId, useState, type ReactElement } from 'react'
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

/**
 * The small form a Person names one of their accounts in. It opens from whatever was pressed
 * (`trigger`), so it is used in the two places a name is asked for:
 *
 * - naming or renaming an account that is already connected (Settings), where saving nothing
 *   takes the name away again (`optional`);
 * - adding one more account to a service that does not say who signed in, where the name is what
 *   will tell the new account from the ones already there, so it must be given before anything
 *   is begun.
 *
 * A name is the Person's own word for the account ("Work"). It is sent to Vivid as the account's
 * name and to nobody else; it is not a sign-in and never reaches the service.
 *
 * The field keeps what is typed only while the form is open: it is mounted with the popup, so a
 * form opened again starts from the name the account has now.
 */
export function NameAccount({
  trigger,
  title,
  why,
  action,
  current,
  others,
  optional,
  onName,
}: {
  /** The control that opens the form; the popover gives it its expanded state. */
  trigger: ReactElement
  title: string
  /** One sentence saying what the name is for, under the title. */
  why: string
  /** What the form's one button does, as a verb: "Save", "Add account". */
  action: string
  /** The name the account has now, when it has one. */
  current: Option.Option<string>
  /** The other accounts on the same service: a name one of them has cannot be given again. */
  others: ReadonlyArray<Pick<Connection, 'name'>>
  /** Whether sending no name is an answer (it removes the name) or not yet an answer. */
  optional: boolean
  onName: (name: Option.Option<AccountName>) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="end">
        <NameForm
          title={title}
          why={why}
          action={action}
          current={current}
          others={others}
          optional={optional}
          onName={(name) => {
            setOpen(false)
            onName(name)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** The form itself. It lives only while the popup is open, which is what resets it. */
function NameForm({
  title,
  why,
  action,
  current,
  others,
  optional,
  onName,
}: {
  title: string
  why: string
  action: string
  current: Option.Option<string>
  others: ReadonlyArray<Pick<Connection, 'name'>>
  optional: boolean
  onName: (name: Option.Option<AccountName>) => void
}) {
  const [written, setWritten] = useState(Option.getOrElse(current, () => ''))
  const field = useId()
  const name = typedAccountName(written)
  // Said beside the field while it is typed, so the server is never asked for a name it refuses.
  const taken = nameTaken(others, name)
  const ready = !taken && (optional || Option.isSome(name))
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) onName(name)
      }}
    >
      <PopoverHeader>
        <PopoverTitle render={<label htmlFor={field} />}>{title}</PopoverTitle>
        <PopoverDescription>{why}</PopoverDescription>
      </PopoverHeader>
      <Input
        id={field}
        compact
        // Focus lands in the field: the form was opened to type one word.
        autoFocus
        value={written}
        onChange={(event) => setWritten(event.currentTarget.value)}
        maxLength={ACCOUNT_NAME_MAX}
        placeholder="Work"
        autoComplete="off"
        autoCapitalize="words"
        spellCheck={false}
        aria-invalid={taken}
        aria-describedby={taken ? `${field}-taken` : undefined}
      />
      {taken && (
        <p id={`${field}-taken`} role="alert" className="text-meta font-meta text-danger">
          Another account here is already called that. Choose a different name.
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!ready}>
          {action}
        </Button>
      </div>
    </form>
  )
}
