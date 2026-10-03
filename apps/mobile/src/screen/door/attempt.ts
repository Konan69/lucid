import { Cause, Option } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import { useState } from 'react'
import { door, useDoor } from '../../data/door'
import { saidFor, type Beside } from '../../data/refusal'
import { emailAtom, type EmailEntry } from '../../data/signing'

/**
 * One step's use of the sign-in action (`emailAtom`): sending an entry, whether it is on its
 * way, and what came of it in words for this step.
 *
 * The action is one atom for the whole door, so its last failure outlives the step that caused
 * it. A step therefore shows a failure only for an entry it sent itself and that the Person has
 * not edited since: `asked` is set when it sends and cleared by `edited`, so a wrong password
 * from the last step is never said under a field on this one.
 */
export function useAttempt() {
  const result = useDoor(emailAtom)
  const [asked, setAsked] = useState(false)
  const failure =
    asked && !result.waiting && AsyncResult.isFailure(result)
      ? Cause.findErrorOption(result.cause)
      : Option.none()
  const said = Option.map(failure, saidFor)
  /** The sentence for one place on the step, when the failure belongs there. */
  const at = (beside: Beside): Option.Option<string> =>
    Option.flatMap(said, (line) =>
      line.beside === beside ? Option.some(line.words) : Option.none(),
    )
  return {
    busy: result.waiting,
    at,
    edited: () => setAsked(false),
    send: (entry: EmailEntry) => {
      setAsked(true)
      door.set(emailAtom, entry)
    },
  }
}
