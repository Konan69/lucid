import { Shown as ShownKind } from '@vivid/contracts'
import { DRAFT_WORDS as DRAFT, formReply, siteOf as site, togglePicked } from '@vivid/state'
import {
  Check,
  CheckCircle2,
  Circle,
  CircleDot,
  CircleSlash,
  ChevronRight,
  ExternalLink,
  ImageOff,
  Minus,
  Plus,
} from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { pages } from '../../data/pages'
import { Button } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { Copy } from '../../ui/Copy'
import { Chart } from './Chart'

/**
 * What Vivid shows in a Thread when words are the wrong shape: a table, a chart, the steps of a
 * plan, choices, a comparison, a draft. Vivid asks for one with its `show` tool and the request is
 * the thing drawn here; nothing is fetched.
 *
 * The three kinds that take something back (choices, a form, a draft's actions) say what the
 * Person chose as their next message, in plain words. They are only live on the newest reply: an
 * older card is a record of what was asked, and pressing it would answer a question Vivid has
 * stopped asking.
 */
export function Display({
  shown,
  live,
  onSay,
}: {
  shown: ShownKind
  /** Whether this is the newest thing Vivid said and it is waiting for the Person. */
  live: boolean
  onSay: (words: string) => void
}) {
  // Every kind is a named case, so a new kind fails to typecheck here until it has a display.
  return ShownKind.match(shown, {
    Table: (table) => <TableShown table={table} />,
    Chart: (chart) => <ChartShown chart={chart} />,
    Steps: (plan) => <StepsShown plan={plan} />,
    Options: (ask) => <OptionsShown ask={ask} live={live} onSay={onSay} />,
    Comparison: (comparison) => <ComparisonShown comparison={comparison} />,
    Links: (list) => <LinksShown list={list} />,
    Facts: (board) => <FactsShown board={board} />,
    Draft: (draft) => <DraftShown draft={draft} live={live} onSay={onSay} />,
    Schedule: (schedule) => <ScheduleShown schedule={schedule} />,
    Form: (form) => <FormShown form={form} live={live} onSay={onSay} />,
    Pictures: (gallery) => <PicturesShown gallery={gallery} />,
  })
}

type Kind<Tag extends ShownKind['_tag']> = Extract<ShownKind, { readonly _tag: Tag }>

/** The frame every display sits in: one raised surface, with its title when it has one. */
function Frame({
  title,
  flush = false,
  children,
}: {
  title: Kind<'Table'>['title']
  /** The content runs to the frame's edge (a table, a list of rows) and pads itself. */
  flush?: boolean
  children: ReactNode
}) {
  return (
    <section className="mt-3 min-w-0 overflow-hidden rounded-card bg-surface-3 edge">
      {title !== undefined && (
        <h3 className="px-4 pt-3.5 pb-2 text-title font-title text-balance text-ink">{title}</h3>
      )}
      <div className={cn(!flush && 'px-4 pb-4', !flush && title === undefined && 'pt-4')}>
        {children}
      </div>
    </section>
  )
}

/** A cell that reads as a number, a price or a share: what a column of them should line up on. */
const NUMBER = /^[-+−]?[$€£₦¥]?\s?\d[\d,.\s]*(?:%|[kKmMbB]|\s?[A-Za-z]{1,4})?$/u

/** Columns whose every filled cell is a number are set flush right, so digits line up to compare. */
const numericColumns = (table: Kind<'Table'>) =>
  table.columns.map((_, column) => {
    const cells = table.rows
      .map((row) =>
        row
          .slice(column, column + 1)
          .join('')
          .trim(),
      )
      .filter((cell) => cell.length > 0)
    return cells.length > 0 && cells.every((cell) => NUMBER.test(cell))
  })

/**
 * Rows of text under a header that stays put while a long table scrolls inside its frame (sixty
 * rows must not push the conversation off the screen). The first column names the row; numeric
 * columns are right-aligned; a table with no rows says so instead of drawing a lone header.
 */
function TableShown({ table }: { table: Kind<'Table'> }) {
  const numeric = numericColumns(table)
  return (
    <Frame title={table.title} flush>
      <div className="max-h-96 overflow-auto">
        <table className="w-full border-collapse text-left text-label">
          <thead>
            <tr>
              {table.columns.map((column, cell) => (
                <th
                  key={column}
                  scope="col"
                  className={cn(
                    'sticky top-0 bg-surface-3 px-4 py-2 text-meta font-title whitespace-nowrap text-ink-3 hairline-b',
                    numeric[cell] && 'text-right',
                  )}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, at) => (
              <tr
                // Rows have no identity but their place, and the table is drawn once.
                // oxlint-disable-next-line react/no-array-index-key
                key={at}
                className="group/row transition-colors duration-(--dur-fast) hover:bg-wash-hover"
              >
                {table.columns.map((column, cell) => (
                  <td
                    key={column}
                    className={cn(
                      'px-4 py-2.5 align-top tabular-nums hairline-b group-last/row:shadow-none',
                      cell === 0 ? 'font-title text-ink' : 'text-ink-2',
                      numeric[cell] && 'text-right',
                    )}
                  >
                    {row[cell]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {table.rows.length === 0 && (
          <p className="p-4 text-label font-meta text-ink-3">No rows to show.</p>
        )}
      </div>
      {table.note !== undefined && (
        <p className="px-4 py-2.5 text-meta font-meta text-ink-3 hairline-t">{table.note}</p>
      )}
    </Frame>
  )
}

function ChartShown({ chart }: { chart: Kind<'Chart'> }) {
  return (
    <Frame title={chart.title}>
      <Chart chart={chart} />
    </Frame>
  )
}

/** The mark each step wears. Colour is never the only difference: each state has its own shape. */
const STEP = {
  'to do': { icon: <Circle className="size-4 text-ink-4" />, words: 'text-ink-2' },
  doing: { icon: <CircleDot className="size-4 text-working" />, words: 'text-ink font-title' },
  done: { icon: <CheckCircle2 className="size-4 text-success" />, words: 'text-ink-3' },
  skipped: {
    icon: <CircleSlash className="size-4 text-ink-4" />,
    words: 'text-ink-4 line-through',
  },
} as const satisfies Record<
  Kind<'Steps'>['steps'][number]['state'],
  { icon: ReactNode; words: string }
>

/** A plan as a timeline: a rail joins the marks, so the order reads as a path and not a list. */
function StepsShown({ plan }: { plan: Kind<'Steps'> }) {
  const done = plan.steps.filter((step) => step.state === 'done').length
  return (
    <Frame title={plan.title}>
      <p className="mb-3 text-meta font-meta text-ink-3 tabular-nums">
        {done} of {plan.steps.length} done
      </p>
      <ol>
        {plan.steps.map((step) => (
          <li
            key={step.label}
            aria-current={step.state === 'doing' ? 'step' : undefined}
            className="relative flex items-start gap-2.5 pb-3.5 before:absolute before:top-6 before:bottom-0.5 before:left-2 before:w-px before:bg-line-2 last:pb-0 last:before:hidden"
          >
            <span className="mt-0.5 shrink-0 bg-surface-3">{STEP[step.state].icon}</span>
            <span className="min-w-0">
              <span className={cn('block text-label', STEP[step.state].words)}>{step.label}</span>
              {step.detail !== undefined && (
                <span className="mt-0.5 block text-meta font-meta text-ink-3">{step.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Frame>
  )
}

/** One choice, or several: what the Person picks is said as their next message. */
function OptionsShown({
  ask,
  live,
  onSay,
}: {
  ask: Kind<'Options'>
  live: boolean
  onSay: (words: string) => void
}) {
  const [picked, setPicked] = useState<ReadonlyArray<string>>([])
  const pick = (label: string) => {
    if (!ask.many) {
      onSay(label)
      return
    }
    setPicked((now) => togglePicked(now, label))
  }
  return (
    <Frame title={ask.question}>
      <ul className="mt-1 flex flex-col gap-1.5">
        {ask.options.map((option) => {
          const on = picked.includes(option.label)
          return (
            <li key={option.label}>
              <button
                disabled={!live}
                aria-pressed={ask.many ? on : undefined}
                onClick={() => pick(option.label)}
                className={cn(
                  'flex min-h-10 w-full cursor-pointer items-center gap-3 rounded-control px-3 py-2 text-left transition-press duration-(--dur-fast) active:scale-98 disabled:cursor-default active:disabled:scale-100',
                  on ? 'bg-accent-soft' : 'bg-surface-2 hover:enabled:bg-wash-pressed',
                )}
              >
                {ask.many && (
                  <span
                    className={cn(
                      'inline-flex size-4 shrink-0 items-center justify-center rounded-xs',
                      on ? 'bg-accent text-ink-on-accent' : 'ring-1 ring-line-4',
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-label font-title text-ink">{option.label}</span>
                  {option.detail !== undefined && (
                    <span className="block text-meta font-meta text-ink-3">{option.detail}</span>
                  )}
                </span>
                {/* A single choice is sent the moment it is pressed; the arrow says so. */}
                {!ask.many && live && <ChevronRight className="size-4 shrink-0 text-ink-4" />}
              </button>
            </li>
          )
        })}
      </ul>
      {ask.many && live && (
        <Button
          variant="primary"
          size="sm"
          className="mt-3"
          disabled={picked.length === 0}
          onClick={() => onSay(picked.join(', '))}
        >
          {picked.length === 0 ? 'Pick at least one' : `Send ${picked.length}`}
        </Button>
      )}
    </Frame>
  )
}

function ComparisonShown({ comparison }: { comparison: Kind<'Comparison'> }) {
  const picked = comparison.pick === undefined ? '' : comparison.pick.name
  return (
    <Frame title={comparison.title}>
      {/* The far edge fades and the list ends in room to scroll past it, so a card cut off at the
          edge says there is more instead of looking like the whole list. */}
      <ul className="flex snap-x gap-2 overflow-x-auto scroll-fade-end py-1 pr-10">
        {comparison.items.map((item) => (
          <li
            key={item.name}
            className={cn(
              'flex w-60 shrink-0 snap-start flex-col gap-2 rounded-control p-3',
              item.name === picked ? 'bg-accent-soft' : 'bg-surface-2',
            )}
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-label font-title text-ink">
                {item.name}
              </span>
              {item.name === picked && (
                <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-meta font-title text-ink-on-accent">
                  Vivid’s pick
                </span>
              )}
            </span>
            {item.summary !== undefined && (
              <span className="text-label font-meta text-ink-2">{item.summary}</span>
            )}
            <Points points={item.good} good />
            <Points points={item.bad} good={false} />
            {item.facts.length > 0 && (
              <dl className="mt-auto flex flex-col gap-1 pt-1">
                {item.facts.map((fact) => (
                  <div key={fact.label} className="flex items-baseline justify-between gap-3">
                    <dt className="text-meta font-meta text-ink-3">{fact.label}</dt>
                    <dd className="text-right text-meta font-title text-ink tabular-nums">
                      {fact.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ul>
      {comparison.pick !== undefined && (
        <p className="mt-2 text-label text-ink-2">{comparison.pick.why}</p>
      )}
    </Frame>
  )
}

/** What is good or bad about one side of a comparison, each with a plus or a minus. */
function Points({ points, good }: { points: ReadonlyArray<string>; good: boolean }) {
  if (points.length === 0) return null
  return (
    <ul className="flex flex-col gap-1">
      {points.map((point) => (
        <li key={point} className="flex items-start gap-1.5 text-label text-ink-2">
          {good ? (
            <Plus className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={2.5} />
          ) : (
            <Minus className="mt-0.5 size-3.5 shrink-0 text-danger" strokeWidth={2.5} />
          )}
          {point}
        </li>
      ))}
    </ul>
  )
}

function LinksShown({ list }: { list: Kind<'Links'> }) {
  return (
    <Frame title={list.title} flush>
      <ul className={cn(list.title === undefined && 'pt-1.5', 'pb-1.5')}>
        {list.links.map((link) => (
          <li key={link.address}>
            <a
              href={link.address}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                // In the desktop app a link opens beside the Thread, as it does from a reply.
                if (!pages.available || !/^https?:/u.test(link.address)) return
                event.preventDefault()
                pages.open(link.address)
              }}
              className="group/link flex items-start gap-3 px-4 py-2.5 transition-colors duration-(--dur-fast) outline-none hover:bg-wash-hover focus-visible:bg-wash-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-label font-title text-ink">{link.title}</span>
                <span className="block truncate text-meta font-meta text-ink-3">
                  {site(link.address)}
                </span>
                {link.note !== undefined && (
                  <span className="mt-0.5 block text-label text-ink-2">{link.note}</span>
                )}
              </span>
              <ExternalLink className="mt-1 size-3.5 shrink-0 text-ink-4 group-hover/link:text-accent-ink group-focus-visible/link:text-accent-ink" />
            </a>
          </li>
        ))}
      </ul>
    </Frame>
  )
}

const TONE = { good: 'text-success', bad: 'text-danger' } as const

function FactsShown({ board }: { board: Kind<'Facts'> }) {
  return (
    <Frame title={board.title}>
      <dl className="grid grid-cols-facts gap-2">
        {board.facts.map((fact) => (
          <div key={fact.label} className="rounded-control bg-surface-2 px-3 py-2.5">
            <dt className="truncate text-meta font-meta text-ink-3">{fact.label}</dt>
            <dd className="mt-1 font-display text-section font-strong wrap-break-word text-ink tabular-nums">
              {fact.value}
            </dd>
            {fact.change !== undefined && (
              <dd
                className={cn(
                  'mt-0.5 text-meta font-title tabular-nums',
                  fact.tone === undefined ? 'text-ink-3' : TONE[fact.tone],
                )}
              >
                {fact.change}
              </dd>
            )}
          </div>
        ))}
      </dl>
    </Frame>
  )
}

/**
 * Something written for the Person to send. Pressing send says so in the Thread; whether it then
 * goes out is the trust loop's business, so the card never sends anything itself.
 */
function DraftShown({
  draft,
  live,
  onSay,
}: {
  draft: Kind<'Draft'>
  live: boolean
  onSay: (words: string) => void
}) {
  const words = DRAFT[draft.kind]
  return (
    <Frame title={words.name}>
      <dl className="flex flex-col gap-1 text-label">
        {draft.to.length > 0 && (
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-ink-3">To</dt>
            <dd className="min-w-0 wrap-break-word text-ink">{draft.to.join(', ')}</dd>
          </div>
        )}
        {draft.subject !== undefined && (
          <div className="flex gap-2">
            <dt className="w-14 shrink-0 text-ink-3">Subject</dt>
            <dd className="min-w-0 font-title wrap-break-word text-ink">{draft.subject}</dd>
          </div>
        )}
      </dl>
      <p className="mt-3 max-h-80 overflow-y-auto rounded-control bg-well px-3.5 py-3 text-title leading-relaxed wrap-break-word whitespace-pre-wrap text-ink">
        {draft.body}
      </p>
      <div className="mt-3 flex items-center gap-2">
        {live && (
          <Button variant="primary" size="sm" onClick={() => onSay(`${words.send}.`)}>
            {words.send}
          </Button>
        )}
        <span className="flex-1" />
        <Copy name="the draft" read={() => draft.body} />
      </div>
    </Frame>
  )
}

function ScheduleShown({ schedule }: { schedule: Kind<'Schedule'> }) {
  return (
    <Frame title={schedule.title === undefined ? schedule.day : schedule.title}>
      {schedule.title !== undefined && schedule.day !== undefined && (
        <p className="mb-2 text-meta font-meta text-ink-3">{schedule.day}</p>
      )}
      <ol className="flex flex-col">
        {schedule.items.map((item) => (
          <li
            key={`${item.at}:${item.title}`}
            className="flex gap-3 py-2 hairline-b last:shadow-none"
          >
            <span className="w-20 shrink-0 text-label font-title text-ink tabular-nums">
              {item.at}
              {item.until !== undefined && (
                <span className="block text-meta font-meta text-ink-3">until {item.until}</span>
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-label font-title text-ink">{item.title}</span>
              {item.where !== undefined && (
                <span className="block text-meta font-meta text-ink-3">{item.where}</span>
              )}
              {item.note !== undefined && (
                <span className="block text-meta text-ink-2">{item.note}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Frame>
  )
}

const FIELD =
  'w-full rounded-control bg-well px-3 py-2 text-label text-ink outline-none placeholder:text-ink-4 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'

/**
 * A few details Vivid needs, asked for at once. What is filled in is said back as lines of
 * "label: value", so the answer in the Thread is readable on its own. It is not for secrets: a
 * key or a password goes to its integration, never into a Thread.
 */
function FormShown({
  form,
  live,
  onSay,
}: {
  form: Kind<'Form'>
  live: boolean
  onSay: (words: string) => void
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const filled = new FormData(event.currentTarget)
    const words = formReply(
      form.fields.map((field) => {
        const value = filled.get(field.label)
        // A form's entries can be files; these fields are all text.
        const text = value === null || value instanceof File ? '' : value.trim()
        return { label: field.label, value: text }
      }),
    )
    if (words.length > 0) onSay(words)
  }
  return (
    <Frame title={form.title}>
      <form onSubmit={submit} className="mt-1 flex flex-col gap-3">
        {form.fields.map((field) => (
          <label key={field.label} className="flex flex-col gap-1.5">
            <span className="text-meta font-title text-ink-2">{field.label}</span>
            <Field field={field} disabled={!live} />
          </label>
        ))}
        {live && (
          <Button type="submit" variant="primary" size="sm" className="self-start">
            {form.submit}
          </Button>
        )}
      </form>
    </Frame>
  )
}

/** One field of a form, as the control its kind calls for. Its name is its label. */
function Field({ field, disabled }: { field: Kind<'Form'>['fields'][number]; disabled: boolean }) {
  switch (field.kind) {
    case 'long text':
      return (
        <textarea
          name={field.label}
          rows={3}
          disabled={disabled}
          placeholder={field.example}
          className={cn(FIELD, 'resize-y')}
        />
      )
    case 'choice':
      return (
        <select name={field.label} disabled={disabled} className={cn(FIELD, 'cursor-pointer')}>
          {field.choices.map((choice) => (
            <option key={choice}>{choice}</option>
          ))}
        </select>
      )
    // These kinds are also the names of the browser's own input types.
    case 'text':
    case 'number':
    case 'date':
      return (
        <input
          name={field.label}
          type={field.kind}
          disabled={disabled}
          placeholder={field.example}
          className={FIELD}
        />
      )
  }
}

function PicturesShown({ gallery }: { gallery: Kind<'Pictures'> }) {
  return (
    <Frame title={gallery.title}>
      <ul className="grid grid-cols-pictures gap-2">
        {gallery.pictures.map((picture) => (
          <li key={picture.address}>
            <Picture picture={picture} />
          </li>
        ))}
      </ul>
    </Frame>
  )
}

/**
 * One picture. An address Vivid gave can be dead or not an image at all, so a failed load is a
 * tile that says so, not a broken-image icon and the caption floating under nothing. Opening it
 * goes to the picture itself, at full size.
 */
function Picture({ picture }: { picture: Kind<'Pictures'>['pictures'][number] }) {
  const [failed, setFailed] = useState(false)
  const caption = picture.caption
  return (
    <figure>
      {failed ? (
        <div className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-control bg-surface-2 text-ink-3">
          <ImageOff className="size-5" />
          <span className="text-meta font-meta">Could not load</span>
        </div>
      ) : (
        <a
          href={picture.address}
          target="_blank"
          rel="noreferrer"
          className="block cursor-pointer rounded-control outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img
            src={picture.address}
            alt={caption === undefined ? '' : caption}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="aspect-square w-full rounded-control bg-surface-2 object-cover picture-edge"
          />
        </a>
      )}
      {caption !== undefined && (
        <figcaption className="mt-1 truncate text-meta font-meta text-ink-3">{caption}</figcaption>
      )}
    </figure>
  )
}
