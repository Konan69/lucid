import { PROJECT_TEXT_MAX, ProjectWork, type Project } from '@vivid/contracts'
import { goal } from '@vivid/state'
import { Option } from 'effect'
import { useId, useState } from 'react'
import { closeGoal, saveGoal } from '../../data/goal'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog'
import { Field, FieldLabel } from '../../ui/field'
import { useSurface } from '../../ui/Layer'
import { Textarea } from '../../ui/textarea'

/**
 * The form a Person sets a Project's goal in, or marks it done in. Whether it is up, saving or
 * refused is the `goal` machine's (`data/goal.ts`); this draws the form the machine has open and
 * sends Save. It is mounted with the dialog, so the fields start from what the Project says now
 * each time it opens.
 */
export function GoalDialog({
  project,
  form,
  reading,
}: {
  project: Project
  form: goal.Form
  reading: goal.Reading
}) {
  // Sent away (Escape, a click outside) it plays out before the machine is told.
  const surface = useSurface(closeGoal)
  return (
    <Dialog {...surface}>
      <DialogContent>
        {form === 'Goal' ? (
          <GoalForm project={project} reading={reading} />
        ) : (
          <DoneForm project={project} reading={reading} />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** What the Goal form says for each state of the work, and the objective it starts from. */
const goalWords = (work: ProjectWork) =>
  ProjectWork.match(work, {
    Unspecified: () => ({
      title: 'Set a goal',
      submit: 'Save goal',
      objective: '',
      nextStep: '',
    }),
    Active: (active) => ({
      title: 'Edit goal',
      submit: 'Save goal',
      objective: active.objective,
      nextStep: active.nextStep,
    }),
    // Reopening keeps what done meant; the next step is new, because the last one led to done.
    Completed: (completed) => ({
      title: 'Reopen project',
      submit: 'Reopen project',
      objective: completed.objective,
      nextStep: '',
    }),
  })

/** The objective and the one next step toward it: a `Define` change. */
function GoalForm({ project, reading }: { project: Project; reading: goal.Reading }) {
  const words = goalWords(project.work)
  const [objective, setObjective] = useState(words.objective)
  const [nextStep, setNextStep] = useState(words.nextStep)
  const objectiveField = useId()
  const nextField = useId()
  const typedObjective = goal.typedText(objective)
  const typedNext = goal.typedText(nextStep)
  const waiting = goal.isWaiting(reading)
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault()
        if (Option.isSome(typedObjective) && Option.isSome(typedNext))
          saveGoal(goal.goalRequest(project, typedObjective.value, typedNext.value))
      }}
    >
      <DialogHeader>
        <DialogTitle>{words.title}</DialogTitle>
        <DialogDescription>
          Vivid works toward it and notes progress here as it happens.
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={objectiveField}>What done looks like</FieldLabel>
        <Textarea
          id={objectiveField}
          // A dialog opened to say this one thing; the cursor belongs in it.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          rows={2}
          maxLength={PROJECT_TEXT_MAX}
          value={objective}
          disabled={waiting}
          onChange={(event) => setObjective(event.currentTarget.value)}
          placeholder="Everyone works from the new office by March"
          className="max-h-40"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={nextField}>Next step</FieldLabel>
        <Textarea
          id={nextField}
          rows={1}
          maxLength={PROJECT_TEXT_MAX}
          value={nextStep}
          disabled={waiting}
          onChange={(event) => setNextStep(event.currentTarget.value)}
          placeholder="Sign the lease"
          className="max-h-32 min-h-10"
        />
      </Field>
      <Footer
        reading={reading}
        submit={words.submit}
        ready={Option.isSome(typedObjective) && Option.isSome(typedNext)}
      />
    </form>
  )
}

/** What shows the Project is done, in the Person's words: a `Confirm` change. */
function DoneForm({ project, reading }: { project: Project; reading: goal.Reading }) {
  const [summary, setSummary] = useState('')
  const field = useId()
  const typed = goal.typedText(summary)
  const waiting = goal.isWaiting(reading)
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault()
        if (Option.isSome(typed)) saveGoal(goal.doneRequest(project, typed.value))
      }}
    >
      <DialogHeader>
        <DialogTitle>Mark project done</DialogTitle>
        <DialogDescription>
          Say what shows it is done. It stays with the project, and you can reopen it later.
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={field}>What shows it is done</FieldLabel>
        <Textarea
          id={field}
          // A dialog opened to say this one thing; the cursor belongs in it.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          rows={2}
          maxLength={PROJECT_TEXT_MAX}
          value={summary}
          disabled={waiting}
          onChange={(event) => setSummary(event.currentTarget.value)}
          placeholder="The team moved in on Monday"
          className="max-h-40"
        />
      </Field>
      <Footer reading={reading} submit="Mark done" ready={Option.isSome(typed)} />
    </form>
  )
}

/** The refusal, if the last save had one, then Cancel and the form's own Save. */
function Footer({
  reading,
  submit,
  ready,
}: {
  reading: goal.Reading
  submit: string
  ready: boolean
}) {
  const refusal = goal.refusalOf(reading)
  const waiting = goal.isWaiting(reading)
  return (
    <>
      {Option.isSome(refusal) && (
        <p role="alert" className="text-meta font-meta text-pretty text-danger">
          {refusal.value}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={closeGoal}>
          Cancel
        </Button>
        <Button type="submit" disabled={waiting || !ready}>
          {goal.Reading.guards.Saving(reading) ? 'Saving…' : submit}
        </Button>
      </DialogFooter>
    </>
  )
}
