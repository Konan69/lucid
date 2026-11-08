import { defineComponent } from '@openuidev/react-lang'
import { Option } from 'effect'
import { useState } from 'react'
import { z } from 'zod/v4'

/**
 * The days of a `Week`, as the display writes them. The model writes each day's name and date
 * the way they should read ("Tue", "21"), so no calendar or time zone is worked out here: the
 * display already said them in the Person's own.
 */
export const weekDays = z.array(
  z.object({
    day: z.string(),
    date: z.union([z.string(), z.number()]),
    items: z.array(z.object({ time: z.string(), title: z.string() })).optional(),
    marked: z.boolean().optional(),
  }),
)
type Day = z.infer<typeof weekDays>[number]

/** At most this many dots under a day; more would not be read as a count anyway. */
const MOST_DOTS = 3

/**
 * The day the strip opens on: the one the display marked, else the first with something on it,
 * else the first. Read on every render, so a mark that arrives while the reply streams is taken.
 */
export const openingDay = (days: ReadonlyArray<Day>) => {
  const marked = days.findIndex((day) => day.marked === true)
  if (marked !== -1) return marked
  const busy = days.findIndex((day) => (day.items ?? []).length > 0)
  return busy === -1 ? 0 : busy
}

/**
 * A week as a strip of days, the calendar's own picture (the 13 October Feed's "week strip"):
 * each day's name, its date and a dot for each thing on it, the marked day in the blue of the
 * family, and under the strip what is on the day being looked at. Pressing a day shows its
 * things; that is the strip's own reading and needs no reply, so it is plain state here. A press
 * the Person made wins over the display's mark from then on.
 */
export const Week = defineComponent({
  name: 'Week',
  props: z.object({ days: weekDays }),
  description:
    'A week as a strip of days with what is on each: days are {day: "Tue", date: "21", items: [{time: "9:00", title: "Call with Iyin"}], marked: true}; marked is the day the card is about.',
  component: function Strip({ props }) {
    const days = props.days
    const [picked, pick] = useState<Option.Option<number>>(Option.none())
    const shown = Option.getOrElse(
      Option.filter(picked, (index) => index < days.length),
      () => openingDay(days),
    )
    const items = Option.match(Option.fromUndefinedOr(days[shown]), {
      onNone: () => [],
      onSome: (day) => day.items ?? [],
    })
    return (
      <div className="vivid-week">
        <div
          className="vivid-week-days"
          style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
        >
          {days.map((day, index) => (
            <button
              key={`${day.day}:${day.date}`}
              type="button"
              className="vivid-week-day"
              aria-pressed={index === shown}
              data-marked={day.marked === true ? '' : undefined}
              onClick={() => pick(Option.some(index))}
            >
              <span className="vivid-week-name">{day.day}</span>
              <span className="vivid-week-date">{day.date}</span>
              <span className="vivid-week-dots" aria-label={`${(day.items ?? []).length} on`}>
                {(day.items ?? []).slice(0, MOST_DOTS).map((item) => (
                  <span key={`${item.time}:${item.title}`} />
                ))}
              </span>
            </button>
          ))}
        </div>
        {items.length === 0 ? (
          <p className="vivid-week-free">Nothing planned</p>
        ) : (
          <ul className="vivid-week-items">
            {items.map((item) => (
              <li key={`${item.time}:${item.title}`}>
                <span className="vivid-week-time">{item.time}</span>
                <span className="vivid-week-title">{item.title}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  },
})
