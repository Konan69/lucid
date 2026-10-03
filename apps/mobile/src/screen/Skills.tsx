import type { Skill, SkillId, ThreadId } from '@vivid/contracts'
import { Data, Option } from 'effect'
import { useState } from 'react'
import { ScrollView } from 'react-native'
import { Plus } from 'lucide-react-native'
import { LiveState, useLive, useLiveData } from '../data/live'
import { isSaved } from '../data/skills'
import { Header, Screen } from '../ui/Header'
import { Row, Section } from '../ui/List'
import { Live } from '../ui/Live'
import { Button, Empty, IconButton, Notice, Skeleton, styles } from '../ui/ui'
import { useGo } from '../workspace'
import { Detail } from './skills/Detail'
import { Editor } from './skills/Editor'

/**
 * What is open over the list, one thing at a time. A skill is held by its id, never copied: the
 * one shown is found in the live list on every render, so a skill forgotten from another device
 * simply closes.
 */
type Over = Data.TaggedEnum<{
  Nothing: {}
  Reading: { readonly id: SkillId }
  Editing: { readonly id: SkillId }
  Writing: {}
}>
const Over = Data.taggedEnum<Over>()

/** The skill with this id in the live list, when it is still there. */
const found = (skills: ReadonlyArray<Skill>, id: SkillId): Option.Option<Skill> =>
  Option.fromUndefinedOr(skills.find((skill) => skill.id === id))

/**
 * Skills: the place to manage what Vivid knows how to do. "Yours" is what this Person or their
 * Company taught it or wrote here, which can be read, tried, edited and forgotten. "Built in" is
 * what ships with Vivid, which can be read and tried.
 *
 * Each row is a name and one plain line of when Vivid uses it. Everything it does is one of the
 * server's own calls, reached through `data/skills.ts`; what a manager would also want and the
 * server does not offer yet is not drawn.
 */
export function Skills() {
  const data = useLiveData()
  const go = useGo()
  const list = useLive(data.live.skills)
  const [over, setOver] = useState<Over>(Over.Nothing())
  // Forgetting closes the sheet at once, so a refused one has only the list to be said in.
  const [unforgotten, setUnforgotten] = useState<Option.Option<string>>(Option.none())
  const close = () => setOver(Over.Nothing())
  const write = () => setOver(Over.Writing())
  const skills = LiveState.$is('Ready')(list) ? list.value.skills : []
  return (
    <Screen>
      <Header
        title="Skills"
        onBack={go.goBack}
        trailing={<IconButton icon={Plus} label="New skill" onPress={write} />}
      />
      <ScrollView contentContainerStyle={[styles.page, styles.column]}>
        {Option.isSome(unforgotten) && <Notice message={unforgotten.value} />}
        <Live state={list} loading={<Skeleton rows={6} />}>
          {(value) => (
            <Shelves
              skills={value.skills}
              onWrite={write}
              onOpen={(skill) => {
                // The Person has moved on, so an old refusal is taken down.
                setUnforgotten(Option.none())
                setOver(Over.Reading({ id: skill.id }))
              }}
            />
          )}
        </Live>
      </ScrollView>
      <Opened
        over={over}
        skills={skills}
        onClose={close}
        onEdit={(id) => setOver(Over.Editing({ id }))}
        onStarted={(thread) => {
          close()
          go.navigate('Chat', { id: thread })
        }}
        onUnforgotten={(message) => setUnforgotten(Option.some(message))}
      />
    </Screen>
  )
}

/**
 * The sheet that is open, if any. A skill being read or edited is looked up in the live list
 * here; one that is no longer there draws nothing, which is how its sheet closes.
 */
function Opened({
  over,
  skills,
  onClose,
  onEdit,
  onStarted,
  onUnforgotten,
}: {
  over: Over
  skills: ReadonlyArray<Skill>
  onClose: () => void
  onEdit: (id: SkillId) => void
  onStarted: (thread: ThreadId) => void
  onUnforgotten: (message: string) => void
}) {
  if (Over.$is('Nothing')(over)) return null
  if (Over.$is('Writing')(over)) return <Editor editing={Option.none()} onClose={onClose} />
  const skill = found(skills, over.id)
  if (Option.isNone(skill)) return null
  if (Over.$is('Editing')(over)) return <Editor key={over.id} editing={skill} onClose={onClose} />
  return (
    <Detail
      key={over.id}
      skill={skill.value}
      onClose={onClose}
      onEdit={() => onEdit(over.id)}
      onStarted={onStarted}
      onUnforgotten={onUnforgotten}
    />
  )
}

/** The two shelves: the Person's own first, then what ships with Vivid. */
function Shelves({
  skills,
  onOpen,
  onWrite,
}: {
  skills: ReadonlyArray<Skill>
  onOpen: (skill: Skill) => void
  onWrite: () => void
}) {
  const yours = skills.filter(isSaved)
  const shipped = skills.filter((skill) => !isSaved(skill))
  return (
    <>
      {yours.length > 0 && (
        <Section title="Yours">
          {yours.map((skill) => (
            <Row
              key={skill.id}
              title={skill.name}
              detail={skill.useWhen}
              onPress={() => onOpen(skill)}
            />
          ))}
        </Section>
      )}
      {yours.length === 0 && (
        <Empty line="Nothing here yet. Write a skill, or tell Vivid “remember how we did this” after it does something the way you like.">
          <Button icon={Plus} label="New skill" onPress={onWrite} />
        </Empty>
      )}
      {shipped.length > 0 && (
        <Section title="Built in">
          {shipped.map((skill) => (
            <Row
              key={skill.id}
              title={skill.name}
              detail={skill.useWhen}
              onPress={() => onOpen(skill)}
            />
          ))}
        </Section>
      )}
    </>
  )
}
