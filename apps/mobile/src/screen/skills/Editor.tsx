import { Workspace, type Skill } from '@vivid/contracts'
import { Option } from 'effect'
import { useState } from 'react'
import { confirm } from '../../data/haptics'
import { refusalOf, useLiveData } from '../../data/live'
import { patchSkill, saveSkill } from '../../data/skills'
import { Sheet } from '../../ui/Sheet'
import { Button, Chips, Field, Labelled, Notice } from '../../ui/ui'
import { useMe } from '../../workspace'

/** The four things a skill is made of, in the order they are asked. */
interface Draft {
  readonly name: string
  readonly about: string
  readonly useWhen: string
  readonly instructions: string
}

const EMPTY: Draft = { name: '', about: '', useWhen: '', instructions: '' }

/** The server's own limits (`SaveSkillRequest`), so a field stops where a save would be refused. */
const LIMIT = { name: 80, about: 300, useWhen: 300, instructions: 20_000 } as const

/** Who a new skill is for, when the Person is working in a Company. */
const AUDIENCE = [
  { value: 'me', label: 'Just me' },
  { value: 'company', label: 'Everyone here' },
] as const
type Audience = (typeof AUDIENCE)[number]['value']

/**
 * Writing a skill, or changing one: its name, what it does, when Vivid should use it, and how to
 * do it. `editing` is the skill being changed; without one this makes a new skill.
 *
 * A new skill in a Company asks who it is for, because that cannot be changed afterwards (the
 * server has no call for it). In a Person's own space it is theirs and nothing is asked.
 *
 * The button is always there to be pressed. Pressing it with something missing says which field,
 * instead of leaving a dimmed button to explain nothing.
 */
export function Editor({
  editing,
  onClose,
}: {
  editing: Option.Option<Skill>
  onClose: () => void
}) {
  const data = useLiveData()
  const me = useMe()
  const [draft, setDraft] = useState<Draft>(() =>
    Option.match(editing, {
      onNone: () => EMPTY,
      onSome: ({ name, about, useWhen, instructions }) => ({ name, about, useWhen, instructions }),
    }),
  )
  const [audience, setAudience] = useState<Audience>('me')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<Option.Option<string>>(Option.none())
  const set = (field: keyof Draft) => (text: string) =>
    setDraft((now) => ({ ...now, [field]: text }))
  const written: Draft = {
    name: draft.name.trim(),
    about: draft.about.trim(),
    useWhen: draft.useWhen.trim(),
    instructions: draft.instructions.trim(),
  }
  const shared = Workspace.guards.Company(me.workspace)

  async function save() {
    if (busy) return
    if (Object.values(written).some((text) => text.length === 0)) {
      setSaid(Option.some('Fill in all four before saving.'))
      return
    }
    setBusy(true)
    const result = await Option.match(editing, {
      onNone: () => saveSkill(data, { ...written, forCompany: shared && audience === 'company' }),
      onSome: (skill) => patchSkill(data, skill.id, written),
    })
    setBusy(false)
    const refusal = refusalOf(result)
    setSaid(refusal)
    if (Option.isNone(refusal)) {
      confirm()
      onClose()
    }
  }

  return (
    <Sheet
      title={Option.isSome(editing) ? 'Edit skill' : 'New skill'}
      onClose={onClose}
      footer={
        <>
          {Option.isSome(said) && <Notice message={said.value} />}
          <Button
            morph
            kind="primary"
            label={busy ? 'Saving…' : 'Save'}
            disabled={busy}
            onPress={() => void save()}
            containerStyle={{ marginTop: 8 }}
          />
        </>
      }
    >
      <Labelled label="Name">
        <Field
          accessibilityLabel="Name"
          value={draft.name}
          placeholder="Weekly report"
          maxLength={LIMIT.name}
          onChangeText={set('name')}
        />
      </Labelled>
      <Labelled label="What it does for you">
        <Field
          accessibilityLabel="What it does for you"
          value={draft.about}
          placeholder="Puts the week’s numbers in one page."
          maxLength={LIMIT.about}
          multiline
          onChangeText={set('about')}
        />
      </Labelled>
      <Labelled label="When Vivid should use it">
        <Field
          accessibilityLabel="When Vivid should use it"
          value={draft.useWhen}
          placeholder="When I ask for the weekly report."
          maxLength={LIMIT.useWhen}
          multiline
          onChangeText={set('useWhen')}
        />
      </Labelled>
      <Labelled label="How to do it">
        <Field
          accessibilityLabel="How to do it"
          value={draft.instructions}
          placeholder="The steps, in order. Say what needs your approval."
          maxLength={LIMIT.instructions}
          multiline
          textAlignVertical="top"
          onChangeText={set('instructions')}
          style={{ minHeight: 180 }}
        />
      </Labelled>
      {shared && Option.isNone(editing) && (
        <Labelled label="Who it is for">
          <Chips label="Who it is for" value={audience} options={AUDIENCE} onChange={setAudience} />
        </Labelled>
      )}
    </Sheet>
  )
}
