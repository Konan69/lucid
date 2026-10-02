import { SkillScope, type Skill, type SkillId, type ThreadId } from '@vivid/contracts'
import { Option } from 'effect'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import {
  BookOpenCheck,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Globe,
  GraduationCap,
  Inbox,
  NotebookPen,
  Plug,
  Radar,
  Reply,
  Search,
  Sparkles,
  Sunrise,
  Target,
  type LucideIcon,
} from 'lucide-react-native'
import { commit, warn } from '../data/haptics'
import { LiveState, refusalOf, useLive, useLiveData } from '../data/live'
import { Start, startThread } from '../data/threads'
import { useTheme } from '../theme'
import { Header, Screen } from '../ui/Header'
import { Row, Section } from '../ui/List'
import { Live } from '../ui/Live'
import { openWebLink, Prose } from '../ui/Prose'
import { Sheet } from '../ui/Sheet'
import {
  Button,
  Card,
  confirmDestructive,
  HAIRLINE,
  Label,
  Notice,
  Press,
  radius,
  Skeleton,
  styles,
} from '../ui/ui'
import { useGo } from '../workspace'

/** A procedure the Person or their Company saved, as opposed to one that ships with Vivid. */
const taught = (skill: Skill): boolean => !SkillScope.guards.BuiltIn(skill.scope)

/**
 * What a Person says to try a skill. Nothing is run by a switch: trying one starts a Thread and
 * asks for it in words, the way a Person would, so what happens next is an ordinary conversation.
 * The sentence is the web's (`apps/web/src/screen/Skills.tsx`), so Vivid is asked the same way
 * from either surface.
 */
const tryingWords = (skill: Skill): string =>
  `Help me with this: ${skill.name.toLocaleLowerCase()}.`

/**
 * The icon a skill wears. The ones that come with Vivid are known by name; anything else, and
 * anything a Person taught, wears the same spark, so nothing is guessed from its wording.
 */
const MARKS = new Map<string, LucideIcon>([
  ['Connect a service', Plug],
  ['Work in a signed-in browser', Globe],
  ['Deep research', Search],
  ['Triage my inbox', Inbox],
  ['Draft a reply', Reply],
  ['Morning brief', Sunrise],
  ['Find time and schedule', CalendarClock],
  ['Prepare for a meeting', NotebookPen],
  ['Chase an outcome', Target],
  ['Watch a useful signal', Radar],
  ['Remember and correct preferences', BookOpenCheck],
  ['Learn how we do this', GraduationCap],
])

/** The icon for a skill of this name: its own when Vivid ships it, the spark otherwise. */
const markOf = (name: string): LucideIcon =>
  Option.getOrElse(Option.fromUndefinedOr(MARKS.get(name)), () => Sparkles)

/** The side of the tile a skill's icon sits in. */
const TILE = 36

/** A skill's icon on a soft tile of Vivid's own colour, at the head of its row. */
function Mark({ icon: Icon }: { icon: LucideIcon }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        width: TILE,
        height: TILE,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.row,
        backgroundColor: c['accent-soft'],
      }}
    >
      <Icon pointerEvents="none" size={18} strokeWidth={1.75} color={c['accent-ink']} />
    </View>
  )
}

/**
 * Skills: what Vivid knows how to do. Some of it comes with Vivid, a starter set of procedures
 * that work from the first day. The rest is what this Person or their Company has taught it.
 *
 * The list is read live and nothing is copied out of it: the skill whose sheet is open is found
 * in the list on every render, so one forgotten from another device simply closes.
 */
export function Skills() {
  const data = useLiveData()
  const go = useGo()
  const list = useLive(data.live.skills)
  const [openId, setOpenId] = useState<Option.Option<SkillId>>(Option.none())
  // Forgetting closes the sheet at once, so a refused one has only the list to be said in.
  const [unforgotten, setUnforgotten] = useState<Option.Option<string>>(Option.none())
  const close = () => setOpenId(Option.none())
  // A skill open here can be forgotten from somewhere else; its sheet then simply is not drawn.
  const selected = LiveState.$is('Ready')(list)
    ? Option.flatMap(openId, (id) =>
        Option.fromUndefinedOr(list.value.skills.find((skill) => skill.id === id)),
      )
    : Option.none<Skill>()
  return (
    <Screen>
      <Header title="Skills" onBack={go.goBack} />
      <ScrollView contentContainerStyle={[styles.page, styles.column]}>
        <View style={{ gap: 8, paddingHorizontal: 4 }}>
          <Label
            accessibilityRole="header"
            size="largeTitle"
            style={{ fontWeight: '600', letterSpacing: -0.4 }}
          >
            What Vivid already knows how to do.
          </Label>
          <Label tone="ink-3">
            Ask for any of these in your own words. When you show Vivid how you like something done,
            it keeps that here too.
          </Label>
        </View>
        {Option.isSome(unforgotten) && <Notice message={unforgotten.value} />}
        <Live state={list} loading={<Skeleton rows={6} />}>
          {(value) => (
            <Shelves
              skills={value.skills}
              onOpen={(skill) => {
                // The Person has moved on, so an old refusal is taken down.
                setUnforgotten(Option.none())
                setOpenId(Option.some(skill.id))
              }}
            />
          )}
        </Live>
      </ScrollView>
      {Option.isSome(selected) && (
        <Detail
          key={selected.value.id}
          skill={selected.value}
          onClose={close}
          onStarted={(id) => {
            close()
            go.navigate('Chat', { id })
          }}
          onUnforgotten={(message) => setUnforgotten(Option.some(message))}
        />
      )}
    </Screen>
  )
}

/** The two shelves: what was taught first, because it is the Person's own, then what ships. */
function Shelves({
  skills,
  onOpen,
}: {
  skills: ReadonlyArray<Skill>
  onOpen: (skill: Skill) => void
}) {
  const yours = skills.filter(taught)
  const shipped = skills.filter((skill) => !taught(skill))
  return (
    <>
      {yours.length > 0 && <Shelf title="Taught by you" skills={yours} onOpen={onOpen} />}
      {shipped.length > 0 && <Shelf title="Comes with Vivid" skills={shipped} onOpen={onOpen} />}
      {yours.length === 0 && (
        <Card>
          <Label size="label" tone="ink-2">
            Nothing taught yet. After Vivid does something the way you like, say “remember how we
            did this” and it will be here.
          </Label>
        </Card>
      )}
    </>
  )
}

function Shelf({
  title,
  skills,
  onOpen,
}: {
  title: string
  skills: ReadonlyArray<Skill>
  onOpen: (skill: Skill) => void
}) {
  return (
    <Section title={title}>
      {skills.map((skill) => (
        <Row
          key={skill.id}
          leading={<Mark icon={markOf(skill.name)} />}
          title={skill.name}
          detail={skill.about}
          onPress={() => onOpen(skill)}
        />
      ))}
    </Section>
  )
}

/**
 * One skill in full, in a sheet: what it is for, the way to try it now, and how Vivid goes about
 * it for whoever wants to read that.
 *
 * Trying it takes the Person to the Thread only once their words are with Vivid, as starting a
 * Thread does everywhere in the app. If the Thread was made and the words did not arrive, trying
 * again speaks into that Thread instead of making a second one.
 */
function Detail({
  skill,
  onClose,
  onStarted,
  onUnforgotten,
}: {
  skill: Skill
  onClose: () => void
  onStarted: (id: ThreadId) => void
  /** Forgetting was refused, said on the list because this sheet has already closed. */
  onUnforgotten: (message: string) => void
}) {
  const data = useLiveData()
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<Option.Option<Start>>(Option.none())

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
        // It leaves the list at once and comes back, with the reason, if the server refuses.
        void data
          .change(
            (client) => client.DeleteSkill({ id: skill.id }),
            () =>
              data.live.skills.expect((current) => ({
                skills: current.skills.filter((kept) => kept.id !== skill.id),
              })),
          )
          .then((result) => {
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
    <Sheet title={skill.name} detail={skill.about} onClose={onClose}>
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Button
        kind="primary"
        label={busy ? 'One moment…' : 'Try it'}
        disabled={busy}
        onPress={() => void tryIt()}
      />
      <Steps instructions={skill.instructions} />
      {taught(skill) && <Button kind="danger" label="Forget this" onPress={forget} />}
    </Sheet>
  )
}

/**
 * How Vivid goes about a skill, for whoever wants to read it. It is written for Vivid, steps and
 * all, so it is kept folded: what a Person needs from this sheet is what the skill is for and
 * the way to try it.
 */
function Steps({ instructions }: { instructions: string }) {
  const { colors: c } = useTheme()
  const [open, setOpen] = useState(false)
  const [unopened, setUnopened] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View style={{ gap: 8 }}>
      <Press
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        // The line is short; the slop makes it as easy to hit as any other control.
        hitSlop={{ top: 10, bottom: 10, right: 16 }}
        onPress={() => setOpen((shown) => !shown)}
        containerStyle={{ alignSelf: 'flex-start' }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 24 }}
      >
        <Chevron pointerEvents="none" size={15} strokeWidth={1.8} color={c['ink-3']} />
        <Label size="label" tone="ink-3">
          How Vivid goes about it
        </Label>
      </Press>
      {open && (
        <View
          style={{
            paddingHorizontal: 14,
            paddingTop: 12,
            // A formatted paragraph leaves ten points under itself.
            paddingBottom: 4,
            borderRadius: radius.control,
            borderWidth: HAIRLINE,
            borderColor: c['line-2'],
            backgroundColor: c['surface-well'],
          }}
        >
          <Prose
            text={instructions}
            plain={instructions}
            onLink={(address) => {
              void openWebLink(address).then((opened) => setUnopened(!opened))
            }}
          />
          {unopened && (
            <Label size="label" tone="status-danger" style={{ marginBottom: 8 }}>
              That link could not be opened.
            </Label>
          )}
        </View>
      )}
    </View>
  )
}
