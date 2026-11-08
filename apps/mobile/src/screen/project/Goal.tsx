import { PROJECT_TEXT_MAX, ProjectWork, type Project } from '@vivid/contracts'
import { goal } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { closeGoal, saveGoal } from '../../data/goal'
import { useLiveData } from '../../data/live'
import { Sheet } from '../../ui/Sheet'
import { Button, Field, Labelled, Notice } from '../../ui/ui'

/**
 * The sheet a Person sets a Project's goal in, or marks it done in, drawn as every form sheet is
 * (`ui/Sheet.tsx`): the fields, a refusal when there is one, and one wide action.
 *
 * Whether it is open, saving or refused belongs to the session's `goal` machine (`data/goal.ts`):
 * the sheet is drawn while the machine has this Project's form open, closing it is the machine's
 * `Close`, and the machine closes it when the server has taken the change. What is typed stays
 * the fields' own, starting from what the Project says now each time the sheet opens.
 */
export function GoalSheet({
  project,
  form,
  reading,
}: {
  project: Project
  form: goal.Form
  reading: goal.Reading
}) {
  return form === 'Goal' ? (
    <GoalForm project={project} reading={reading} />
  ) : (
    <DoneForm project={project} reading={reading} />
  )
}

/** What the Goal sheet says for each state of the work, and the objective it starts from. */
const goalWords = (work: ProjectWork) =>
  ProjectWork.match(work, {
    Unspecified: () => ({ title: 'Set a goal', submit: 'Save goal', objective: '', nextStep: '' }),
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
  const data = useLiveData()
  const words = goalWords(project.work)
  const [objective, setObjective] = useState(words.objective)
  const [nextStep, setNextStep] = useState(words.nextStep)
  const typedObjective = goal.typedText(objective)
  const typedNext = goal.typedText(nextStep)
  const waiting = goal.isWaiting(reading)
  const save = () => {
    if (Option.isSome(typedObjective) && Option.isSome(typedNext) && !waiting)
      saveGoal(data, goal.goalRequest(project, typedObjective.value, typedNext.value))
  }
  return (
    <Sheet
      title={words.title}
      detail="Vivid works toward it and notes progress here as it happens."
      onClose={() => closeGoal(data)}
    >
      <Labelled label="What done looks like">
        <Field
          autoFocus
          multiline
          accessibilityLabel="What done looks like"
          value={objective}
          placeholder="Everyone works from the new office by March"
          maxLength={PROJECT_TEXT_MAX}
          editable={!waiting}
          onChangeText={setObjective}
          style={{ maxHeight: 160, textAlignVertical: 'top' }}
        />
      </Labelled>
      <Labelled label="Next step">
        <Field
          multiline
          accessibilityLabel="Next step"
          value={nextStep}
          placeholder="Sign the lease"
          maxLength={PROJECT_TEXT_MAX}
          editable={!waiting}
          onChangeText={setNextStep}
          style={{ maxHeight: 120, textAlignVertical: 'top' }}
        />
      </Labelled>
      <Refusal reading={reading} />
      <Button
        morph
        kind="primary"
        label={goal.Reading.guards.Saving(reading) ? 'One moment…' : words.submit}
        disabled={waiting || Option.isNone(typedObjective) || Option.isNone(typedNext)}
        onPress={save}
      />
    </Sheet>
  )
}

/** What shows the Project is done, in the Person's words: a `Confirm` change. */
function DoneForm({ project, reading }: { project: Project; reading: goal.Reading }) {
  const data = useLiveData()
  const [summary, setSummary] = useState('')
  const typed = goal.typedText(summary)
  const waiting = goal.isWaiting(reading)
  const save = () => {
    if (Option.isSome(typed) && !waiting) saveGoal(data, goal.doneRequest(project, typed.value))
  }
  return (
    <Sheet
      title="Mark project done"
      detail="Say what shows it is done. It stays with the project, and you can reopen it later."
      onClose={() => closeGoal(data)}
    >
      <Labelled label="What shows it is done">
        <Field
          autoFocus
          multiline
          accessibilityLabel="What shows it is done"
          value={summary}
          placeholder="The team moved in on Monday"
          maxLength={PROJECT_TEXT_MAX}
          editable={!waiting}
          onChangeText={setSummary}
          style={{ maxHeight: 160, textAlignVertical: 'top' }}
        />
      </Labelled>
      <Refusal reading={reading} />
      <Button
        morph
        kind="primary"
        label={goal.Reading.guards.Saving(reading) ? 'One moment…' : 'Mark done'}
        disabled={waiting || Option.isNone(typed)}
        onPress={save}
      />
    </Sheet>
  )
}

/** Why the last save did not land, when it did not. */
function Refusal({ reading }: { reading: goal.Reading }) {
  const refusal = goal.refusalOf(reading)
  return Option.isSome(refusal) ? <Notice message={refusal.value} /> : null
}
