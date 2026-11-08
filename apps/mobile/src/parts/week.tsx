import { defineComponent } from '@openuidev/react-lang'
import { Option } from 'effect'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { z } from 'zod/v4'
import { Press } from '../ui/motion/Pressable'
import { useSkin } from './style'

/**
 * The web's `Week` (`apps/web/vendor/openui/week.tsx`) drawn as native views: the same schema and
 * description, the same day it opens on, and the same rule that a day the Person pressed wins
 * over the display's mark. The days sink when pressed, as every press in the app does (`Press`).
 */
const weekDays = z.array(
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

/** The marked day, else the first with something on it, else the first (the web's `openingDay`). */
const openingDay = (days: ReadonlyArray<Day>) => {
  const marked = days.findIndex((day) => day.marked === true)
  if (marked !== -1) return marked
  const busy = days.findIndex((day) => (day.items ?? []).length > 0)
  return busy === -1 ? 0 : busy
}

export const Week = defineComponent({
  name: 'Week',
  props: z.object({ days: weekDays }),
  description:
    'A week as a strip of days with what is on each: days are {day: "Tue", date: "21", items: [{time: "9:00", title: "Call with Iyin"}], marked: true}; marked is the day the card is about.',
  component: function Strip({ props }) {
    const skin = useSkin()
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
      <View style={styles.week}>
        <View style={styles.days}>
          {days.map((day, index) => {
            const on = index === shown
            const ink = on ? skin.onAccent : skin.ink
            return (
              <Press
                key={`${day.day}:${day.date}`}
                containerStyle={styles.dayBox}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${day.day} ${day.date}, ${(day.items ?? []).length} on`}
                onPress={() => pick(Option.some(index))}
                style={[styles.day, { backgroundColor: on ? skin.accent : skin.codeBackground }]}
              >
                <Text style={[styles.name, { color: ink }]}>{day.day}</Text>
                <Text
                  style={[styles.date, { color: day.marked === true && !on ? skin.info : ink }]}
                >
                  {day.date}
                </Text>
                <View style={styles.dots}>
                  {(day.items ?? []).slice(0, MOST_DOTS).map((item) => (
                    <View
                      key={`${item.time}:${item.title}`}
                      style={[styles.dot, { backgroundColor: ink }]}
                    />
                  ))}
                </View>
              </Press>
            )
          })}
        </View>
        {items.length === 0 ? (
          <Text style={[styles.line, { color: skin.muted }]}>Nothing planned</Text>
        ) : (
          <View style={styles.items}>
            {items.map((item) => (
              <View key={`${item.time}:${item.title}`} style={styles.item}>
                <Text style={[styles.line, styles.time, { color: skin.muted }]}>{item.time}</Text>
                <Text style={[styles.line, styles.title, { color: skin.ink }]}>{item.title}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    )
  },
})

const styles = StyleSheet.create({
  week: { gap: 12 },
  days: { flexDirection: 'row', gap: 4 },
  dayBox: { flex: 1, minWidth: 0 },
  day: {
    alignItems: 'center',
    gap: 2,
    paddingTop: 8,
    paddingBottom: 7,
    borderRadius: 10,
  },
  name: { fontSize: 11, lineHeight: 14, opacity: 0.66 },
  date: { fontSize: 17, lineHeight: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
  dots: { flexDirection: 'row', gap: 3, height: 4 },
  dot: { width: 4, height: 4, borderRadius: 2, opacity: 0.5 },
  items: { gap: 6 },
  item: { flexDirection: 'row', gap: 12 },
  line: { fontSize: 15, lineHeight: 21 },
  time: { width: 64, fontVariant: ['tabular-nums'] },
  title: { flex: 1, minWidth: 0 },
})
