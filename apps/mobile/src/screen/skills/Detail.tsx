import { SkillScope, type Skill, type ThreadId } from '@vivid/contracts'
import { Option } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import { commit, warn } from '../../data/haptics'
import { refusalOf, useLiveData } from '../../data/live'
import { forgetSkill, isSaved } from '../../data/skills'
import { Start, startThread } from '../../data/threads'
import { openWebLink, Prose } from '../../ui/Prose'
import { Sheet } from '../../ui/Sheet'
import { Button, confirmDestructive, Label, Notice } from '../../ui/ui'

/**
 * What a Person says to try a skill. Nothing is run by a switch: trying one starts a Thread and
 * asks for it in words, the way a Person would, so what happens next is an ordinary conversation.
 * The sentence is the web's (`apps/web/src/screen/Skills.tsx`), so Vivid is asked the same way
 * from either surface.
 */
const tryingWords = (skill: Skill): string =>
  `Help me with this: ${skill.name.toLocaleLowerCase()}.`

/** Whose a skill is, in the words the list files it under. */
const whose = (skill: Skill): string =>
  SkillScope.match(skill.scope, {
    Personal: () => 'Yours',
    Company: () => 'Shared with everyone here',
    BuiltIn: () => 'Built in',
  })

/**
 * One skill in full, in a sheet: whose it is, when Vivid uses it, how it goes about it, and what
 * can be done with it. The instructions are written out to be read, not folded away: reading
 * what Vivid will do is what a manager is for.
 *
 * Trying it takes the Person to the Thread only once their words are with Vivid, as starting a
 * Thread does everywhere in the app. If the Thread was made and the words did not arrive, trying
 * again speaks into that Thread instead of making a second one.
 *
 * A saved skill can be edited and forgotten. A built-in one can only be read and tried: the
 * server refuses to change one (`SkillReadOnly`), so those actions are not drawn for it.
 */
export function Detail({
  skill,
  onClose,
  onStarted,
  onEdit,
  onUnforgotten,
}: {
  skill: Skill
  onClose: () => void
  onStarted: (id: ThreadId) => void
  onEdit: () => void
  /** Forgetting was refused, said on the list because this sheet has already closed. */
  onUnforgotten: (message: string) => void
}) {
  const data = useLiveData()
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<Option.Option<Start>>(Option.none())
  const [unopened, setUnopened] = useState(false)

  async function tryIt() {
    if (busy) return
    // Sending is felt, here as from the composer's own button.
    commit()
    setBusy(true)
    const outcome = await startThread(data, {
      message: tryingWords(skill),
      projectId: null,
      // The empty Thread an earlier attempt left behind, when there is one.
      resume: Option.flatMap(last, (earlier) =>
        Start.$is('NotSaid')(earlier) ? Option.some(earlier.id) : Option.none<ThreadId>(),
      ),
    })
    setBusy(false)
    if (Start.$is('Started')(outcome)) {
      onStarted(outcome.id)
      return
    }
    setLast(Option.some(outcome))
  }

  const forget = () =>
    confirmDestructive({
      title: `Forget “${skill.name}”?`,
      detail: 'Vivid will no longer do this the way you taught it.',
      action: 'Forget',
      onConfirm: () => {
        warn()
        onClose()
        void forgetSkill(data, skill.id).then((result) => {
          const refusal = refusalOf(result)
          if (Option.isSome(refusal)) onUnforgotten(refusal.value)
        })
      },
    })

  const refused = Option.flatMap(last, (outcome) =>
    Start.$match(outcome, {
      Started: () => Option.none<string>(),
      NotCreated: ({ message }) => Option.some(message),
      NotSaid: ({ message }) => Option.some(message),
    }),
  )

  return (
    <Sheet
      title={skill.name}
      detail={whose(skill)}
      onClose={onClose}
      footer={
        <View style={{ gap: 8 }}>
          {Option.isSome(refused) && <Notice message={refused.value} />}
          <Button
            morph
            kind="primary"
            label={busy ? 'Starting…' : 'Try it'}
            disabled={busy}
            onPress={() => void tryIt()}
          />
        </View>
      }
    >
      <Label>{skill.about}</Label>
      <View style={{ gap: 4 }}>
        <Label size="label" tone="ink-2" style={{ fontWeight: '600' }}>
          When Vivid uses it
        </Label>
        <Label>{skill.useWhen}</Label>
      </View>
      <View style={{ gap: 4 }}>
        <Label size="label" tone="ink-2" style={{ fontWeight: '600' }}>
          How Vivid goes about it
        </Label>
        <Prose
          text={skill.instructions}
          plain={skill.instructions}
          onLink={(address) => {
            void openWebLink(address).then((opened) => setUnopened(!opened))
          }}
        />
        {unopened && (
          <Label size="label" tone="status-danger">
            That link could not be opened.
          </Label>
        )}
      </View>
      {isSaved(skill) && (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button label="Edit" onPress={onEdit} containerStyle={{ flex: 1 }} />
          <Button kind="danger" label="Forget" onPress={forget} containerStyle={{ flex: 1 }} />
        </View>
      )}
    </Sheet>
  )
}
