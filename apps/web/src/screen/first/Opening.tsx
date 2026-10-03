import type { MeResponse } from '@vivid/contracts'
import { Option } from 'effect'
import { useSyncExternalStore, type ReactNode } from 'react'
import { onboarding } from '../../data/onboarding'
import { useAppearance } from '../../data/vivid'
import { Face } from '../../ui/Face'
import { messageField } from '../thread/field'
import { Asked, Question, type Choice } from '../thread/Question'

/**
 * Vivid speaking first, in the Thread, to someone it has not met. There is no wizard
 * (`docs/23-product-definition.md`, "First run"): these are messages in the conversation, and
 * the Person can ignore every one of them and type.
 *
 * It is three short lines and one question, and nothing else. The design follows the reference
 * assistant's first conversation (Grok Bot: three short messages, then one question card with
 * lettered rows and a way to answer in your own words; no services, no list of jobs, no setup on
 * that screen). Vivid's differs in what it asks: the reference asks which tools the Person has
 * used, and Vivid asks about the Person, because the work has to fit their day. It asks only
 * this one question. Pressing a row sends it as the Person's own words, which starts the real
 * Thread, and Vivid's model asks whatever comes next there. The page's message box is the way to
 * answer in other words, so the card has no field of its own.
 *
 * These are drawn by this app, not stored in the conversation: the server has no way yet to
 * open a Thread with Vivid's own first words. `Opening` is shown on Home before the first Thread
 * exists and `Opened` at the top of that first Thread afterwards, so what Vivid said does not
 * vanish the moment the Person answers it.
 *
 * Each item is an `li`, for the conversation's own list.
 */
export function Opening({ me, onSay }: { me: MeResponse; onSay: (words: string) => void }) {
  const choose = (choice: Choice) => {
    const said = SAYS.get(choice.label)
    // "Something else" has no sentence to send: it is answered in the message box.
    if (said === undefined) {
      const field = messageField()
      if (field !== null) field.focus()
      return
    }
    onboarding.answered(me.person.id, choice.label)
    onSay(said)
  }
  return (
    <>
      <Hello me={me} />
      <Said order={1}>
        <Question
          status={Option.none()}
          title={ASKS}
          choices={DAY}
          allowsOwn={false}
          asked={Asked.Open({ onChoose: choose, onOwn: onSay })}
        />
      </Said>
    </>
  )
}

/**
 * The opening as it stands once it has been answered, above the first Thread. When a row was
 * pressed the question is shown closed down to that row, as any answered question is. When the
 * Person wrote their own words instead, those words are the next message in the Thread, so the
 * question is only one more thing Vivid said.
 */
export function Opened({ me }: { me: MeResponse }) {
  // A string or nothing, not an `Option`: the store hands out a new `Option` each time it is
  // asked, and a snapshot that is never the same object twice would render without end.
  const pressed = useSyncExternalStore(onboarding.subscribe, () =>
    Option.getOrUndefined(onboarding.answer(me.person.id)),
  )
  return (
    <>
      <Hello me={me} />
      <Said order={1}>
        {pressed === undefined ? (
          <Bubble>{ASKS}</Bubble>
        ) : (
          <Question
            status={Option.none()}
            title={ASKS}
            choices={DAY}
            allowsOwn={false}
            asked={Asked.Answered({ answer: pressed, note: Option.none() })}
          />
        )}
      </Said>
    </>
  )
}

/** The one question Vivid's opening asks. */
const ASKS = 'What takes most of your day?'

/** The sentence each row sends as the Person's own words. "Something else" sends none. */
const SAYS = new Map([
  ['Mail and messages', 'Most of my day is mail and messages.'],
  ['Meetings and calls', 'Most of my day is meetings and calls.'],
  ['Building or making things', 'Most of my day is building or making things.'],
  ['Running a team or a business', 'Most of my day is running a team or a business.'],
  ['Studying or research', 'Most of my day is studying or research.'],
])

/** The rows under the question, in order: every answer with a sentence, then the way out. */
const DAY: ReadonlyArray<Choice> = [...SAYS.keys(), 'Something else'].map((label) => ({
  label,
  detail: '',
}))

/** Vivid's three opening lines: who it is, what it does, and why it is about to ask. */
function Hello({ me }: { me: MeResponse }) {
  const { name } = useAppearance()
  const first = me.person.name.trim().split(/\s+/u)[0]
  return (
    <Said order={0} face>
      <Bubble>
        {first === undefined || first.length === 0
          ? `Hey! I’m ${name}.`
          : `Hey ${first}! I’m ${name}.`}
      </Bubble>
      <Bubble>I have my own computer. I do real work in your accounts and report back.</Bubble>
      <Bubble>First I’d like to know you a little, so the work fits.</Bubble>
    </Said>
  )
}

/** How far each of Vivid's opening items waits before it rises in: its place in the order. */
const ORDER = ['[--order:0]', '[--order:2]'] as const

/**
 * One thing Vivid says, in the conversation's column: its face beside the first, and the same
 * gutter under the rest, so cards and bubbles line up with its replies in a real Thread.
 */
function Said({
  order,
  face = false,
  children,
}: {
  order: 0 | 1
  face?: boolean
  children: ReactNode
}) {
  return (
    <li className={`flex motion-enter gap-3 ${ORDER[order]}`}>
      {face ? (
        <Face size={28} className="mt-0.5" mood="happy" />
      ) : (
        <span className="w-7 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    </li>
  )
}

/** A few of Vivid's words, in the bubble its short replies use in a Thread. */
function Bubble({ children }: { children: ReactNode }) {
  return (
    <p className="w-fit max-w-bubble rounded-composer rounded-tl-sm bg-surface-2 px-4 py-2.5 text-body text-pretty text-ink">
      {children}
    </p>
  )
}
