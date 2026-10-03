import { SkillScope, type Skill, type SkillId } from '@vivid/contracts'
import type { LiveStateOf } from '@vivid/state'
import { Option } from 'effect'
import {
  ArrowUpRight,
  BookOpenCheck,
  CalendarClock,
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
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { change, live, LiveState, useLive } from '../data/live'
import { orSay } from '../data/said'
import { startThread } from '../data/threads'
import { Button } from '../ui/Button'
import { cn } from '../ui/cn'
import { Dialog, DialogActions } from '../ui/Dialog'
import { Markdown } from '../ui/Markdown'
import { Notice } from '../ui/Notice'
import { Skeleton } from '../ui/Skeleton'
import { BAR } from './bar'

/**
 * What Vivid knows how to do. Some of it comes with Vivid: a starter set of procedures that work
 * from the first day. The rest is what this Person or their Company has taught it. A skill is
 * never run from here by a switch; trying one starts a Thread and asks for it in words, the same
 * way a Person would, so what happens next is an ordinary conversation.
 */
export function Skills() {
  const state = useLive(live.skills)
  const [openId, setOpenId] = useState<Option.Option<SkillId>>(Option.none())
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-surface-0">
      <header className={BAR}>
        <h1 className="min-w-0 flex-1 truncate text-title font-title text-ink">Skills</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-fade-y">
        <div className="mx-auto w-full max-w-230 px-5 pt-1 pb-10 sm:px-8">
          <p className="max-w-xl font-display text-page font-strong tracking-display text-balance text-ink">
            What Vivid already knows how to do.
          </p>
          <p className="mt-2 max-w-xl text-body text-ink-3">
            Ask for any of these in your own words. When you show Vivid how you like something done,
            it keeps that here too.
          </p>
          <Body state={state} open={openId} onOpen={setOpenId} />
        </div>
      </div>
    </section>
  )
}

/** The shelves once the skills are here; before that, their outline; if they cannot be had, why. */
function Body({
  state,
  open,
  onOpen,
}: {
  state: LiveStateOf<typeof live.skills>
  open: Option.Option<SkillId>
  onOpen: (id: Option.Option<SkillId>) => void
}) {
  if (LiveState.$is('Loading')(state)) {
    return (
      <div className="mt-8">
        <Skeleton of="card" count={6} />
      </div>
    )
  }
  if (LiveState.$is('Failed')(state)) {
    return (
      <div className="mt-8">
        <Notice>{state.failure.message}</Notice>
      </div>
    )
  }
  return (
    <Shelves
      skills={state.value.skills}
      open={Option.flatMap(open, (id) =>
        Option.fromUndefinedOr(state.value.skills.find((skill) => skill.id === id)),
      )}
      onOpen={onOpen}
    />
  )
}

/** A procedure the Person or their Company saved, as opposed to one that ships with Vivid. */
const taught = (skill: Skill) => !SkillScope.guards.BuiltIn(skill.scope)

function Shelves({
  skills,
  open,
  onOpen,
}: {
  skills: ReadonlyArray<Skill>
  open: Option.Option<Skill>
  onOpen: (id: Option.Option<SkillId>) => void
}) {
  const yours = skills.filter(taught)
  const shipped = skills.filter((skill) => !taught(skill))
  return (
    <>
      {yours.length > 0 && (
        <Shelf
          title="Taught by you"
          skills={yours}
          onOpen={(skill) => onOpen(Option.some(skill.id))}
        />
      )}
      <Shelf
        title="Comes with Vivid"
        skills={shipped}
        onOpen={(skill) => onOpen(Option.some(skill.id))}
      />
      {yours.length === 0 && (
        <p className="mt-8 rounded-card bg-surface-2 px-4 py-3.5 text-label text-ink-2">
          Nothing taught yet. After Vivid does something the way you like, say “remember how we did
          this” and it will be here.
        </p>
      )}
      {Option.isSome(open) && <Detail skill={open.value} onClose={() => onOpen(Option.none())} />}
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
  if (skills.length === 0) return null
  return (
    <>
      <h2 className="mt-8 mb-2 text-meta font-title tracking-caps text-ink-3 uppercase">{title}</h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {skills.map((skill) => (
          <li key={skill.id}>
            <button
              onClick={() => onOpen(skill)}
              className="group/skill flex size-full cursor-pointer flex-col gap-3 rounded-card bg-surface-2 p-4 text-left transition-press duration-(--dur-fast) hover:bg-wash-pressed active:scale-98"
            >
              <span className="flex w-full items-start justify-between">
                <Mark name={skill.name} />
                <ArrowUpRight
                  aria-hidden
                  className="size-4 text-ink-4 transition-colors duration-(--dur-fast) group-hover/skill:text-accent-ink"
                />
              </span>
              <span>
                <span className="block text-title font-title text-ink">{skill.name}</span>
                {/* Three lines: every built-in description reads whole in the narrowest column,
                    and one a Person wrote long is still held to the card. */}
                <span className="mt-1 line-clamp-3 text-label font-meta text-ink-3">
                  {skill.about}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * The icon a skill wears. The ones that come with Vivid are known by name; anything else, and
 * anything a Person taught, wears the same spark, so nothing is guessed from its wording.
 */
const ICON = 'size-4.5'
const MARKS = new Map<string, ReactNode>([
  ['Connect a service', <Plug key="plug" className={ICON} strokeWidth={1.75} />],
  ['Work in a signed-in browser', <Globe key="globe" className={ICON} strokeWidth={1.75} />],
  ['Deep research', <Search key="search" className={ICON} strokeWidth={1.75} />],
  ['Triage my inbox', <Inbox key="inbox" className={ICON} strokeWidth={1.75} />],
  ['Draft a reply', <Reply key="reply" className={ICON} strokeWidth={1.75} />],
  ['Morning brief', <Sunrise key="sunrise" className={ICON} strokeWidth={1.75} />],
  ['Find time and schedule', <CalendarClock key="time" className={ICON} strokeWidth={1.75} />],
  ['Prepare for a meeting', <NotebookPen key="prepare" className={ICON} strokeWidth={1.75} />],
  ['Chase an outcome', <Target key="chase" className={ICON} strokeWidth={1.75} />],
  ['Watch a useful signal', <Radar key="watch" className={ICON} strokeWidth={1.75} />],
  [
    'Remember and correct preferences',
    <BookOpenCheck key="remember" className={ICON} strokeWidth={1.75} />,
  ],
  ['Learn how we do this', <GraduationCap key="learn" className={ICON} strokeWidth={1.75} />],
])
const SPARK = <Sparkles className={ICON} strokeWidth={1.75} />

function Mark({ name }: { name: string }) {
  return (
    <span className="inline-flex size-9 items-center justify-center rounded-control bg-accent-soft text-accent-ink">
      {Option.getOrElse(Option.fromUndefinedOr(MARKS.get(name)), () => SPARK)}
    </span>
  )
}

/** One skill in full: when Vivid uses it, how it goes about it, and the way to try it now. */
function Detail({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const remove = () => {
    onClose()
    void orSay(
      change((client) => client.DeleteSkill({ id: skill.id })),
      `“${skill.name}” could not be removed. Try again.`,
    )
  }
  return (
    <Dialog title={skill.name} description={skill.about} width="lg" onClose={onClose}>
      <Steps>{skill.instructions}</Steps>
      <DialogActions>
        {taught(skill) && (
          <Button type="button" variant="ghost" onClick={remove}>
            Forget this
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            onClose()
            startThread(`Help me with this: ${skill.name.toLocaleLowerCase()}.`)
          }}
        >
          Try it
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/**
 * How Vivid goes about a skill, for whoever wants to read it. It is written for Vivid, steps and
 * all, so it is kept folded: what a Person needs from this dialog is what the skill is for and
 * the way to try it.
 */
function Steps({ children }: { children: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
        className="-ml-1 inline-flex cursor-pointer items-center gap-1 rounded-row px-1 py-0.5 text-label text-ink-3 transition-colors duration-(--dur-fast) hover:bg-wash-hover hover:text-ink"
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform duration-(--dur-fast)', open && 'rotate-90')}
        />
        How Vivid goes about it
      </button>
      {open && (
        <div className="mt-2 max-h-80 overflow-y-auto rounded-control bg-well px-4 pt-3 pb-5 text-label text-ink-2">
          <Markdown content={children} />
        </div>
      )}
    </div>
  )
}
