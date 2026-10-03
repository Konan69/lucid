import type { Shown } from '@vivid/contracts'
import { comparisonOrder } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { Minus, Plus, Sparkles } from 'lucide-react-native'
import { tick } from '../../data/haptics'
import { useTheme } from '../../theme'
import { HAIRLINE, Label, radius } from '../../ui/ui'
import { Frame } from './Frame'

type ComparisonKind = Extract<Shown, { readonly _tag: 'Comparison' }>
type Item = ComparisonKind['items'][number]

/** The gap between pages, and how much of the next page shows so the row reads as swipeable. */
const GAP = 12
const PEEK = 28

/**
 * A comparison as a row of pages, one alternative to a page, swiped sideways. Desktop sets them
 * side by side; on a phone that would make each one too narrow to read, so each alternative gets
 * nearly the full width, the next one peeks in at the edge, and the dots say how many there are.
 * Vivid's pick, when it has one, is the first page and says why on its own page.
 */
export function Comparison({ comparison }: { comparison: ComparisonKind }) {
  const items = comparisonOrder(comparison)
  const [width, setWidth] = useState<Option.Option<number>>(Option.none())
  return (
    <Frame title={comparison.title}>
      <View
        onLayout={(event) => {
          const measured = event.nativeEvent.layout.width
          if (measured > 0 && !Option.contains(width, measured)) setWidth(Option.some(measured))
        }}
      >
        {/* Until the reply's width is known, the first alternative stands in its place. */}
        {Option.isNone(width) ? (
          <Page item={items[0]} comparison={comparison} />
        ) : (
          <Pages key={width.value} items={items} width={width.value} comparison={comparison} />
        )}
      </View>
    </Frame>
  )
}

/** Whether Vivid chose this alternative; with no pick, none is marked. */
const isPick = (comparison: ComparisonKind, item: Item): boolean =>
  comparison.pick !== undefined && comparison.pick.name === item.name

/** Page state changes only when momentum ends; the system owns every frame in between. */
function Pages({
  items,
  width,
  comparison,
}: {
  items: ComparisonKind['items']
  width: number
  comparison: ComparisonKind
}) {
  const { colors: c } = useTheme()
  const [page, setPage] = useState(0)
  const each = items.length === 1 ? width : width - PEEK
  return (
    <View style={{ gap: 12 }}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        disableIntervalMomentum
        snapToInterval={each + GAP}
        contentContainerStyle={{ gap: GAP }}
        onMomentumScrollEnd={(event) => {
          const next = Math.max(
            0,
            Math.min(
              items.length - 1,
              Math.round(event.nativeEvent.contentOffset.x / (each + GAP)),
            ),
          )
          if (next !== page) {
            tick()
            setPage(next)
          }
        }}
      >
        {items.map((item) => (
          <View key={item.name} style={{ width: each }}>
            <Page item={item} comparison={comparison} />
          </View>
        ))}
      </ScrollView>
      <View
        accessible
        accessibilityLabel={`${items[page].name}, ${page + 1} of ${items.length}`}
        accessibilityHint={isPick(comparison, items[page]) ? 'Vivid’s pick' : undefined}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}
      >
        {items.map((item, index) => (
          <View
            key={item.name}
            style={{
              width: index === page ? 18 : 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: c[index === page ? 'accent' : 'line-3'],
            }}
          />
        ))}
      </View>
    </View>
  )
}

/** One alternative: its name, then the numbers that decide, then what is good and what is not. */
function Page({ item, comparison }: { item: Item; comparison: ComparisonKind }) {
  const { colors: c } = useTheme()
  const pick = isPick(comparison, item)
  return (
    <View
      style={{
        flex: 1,
        padding: 16,
        gap: 12,
        borderRadius: radius.control,
        backgroundColor: c[pick ? 'accent-soft' : 'surface-2'],
        borderWidth: pick ? 1 : HAIRLINE,
        borderColor: c[pick ? 'accent' : 'line-2'],
      }}
    >
      {pick && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Sparkles pointerEvents="none" size={14} strokeWidth={2} color={c['primary-text']} />
          <Label size="caption" tone="accent-ink">
            Vivid’s pick
          </Label>
        </View>
      )}
      <Label accessibilityRole="header" size="headline">
        {item.name}
      </Label>
      {pick && comparison.pick !== undefined && (
        <Label size="label" tone="ink-2">
          {comparison.pick.why}
        </Label>
      )}
      {item.summary !== undefined && (
        <Label size="label" tone="ink-2">
          {item.summary}
        </Label>
      )}
      {item.facts.length > 0 && (
        <View>
          {item.facts.map((fact) => (
            <View
              key={fact.label}
              accessible
              accessibilityLabel={`${fact.label}: ${fact.value}`}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                gap: 12,
                paddingVertical: 8,
                borderTopWidth: HAIRLINE,
                borderTopColor: c.border,
              }}
            >
              <Label size="label" tone="ink-2" style={{ flexShrink: 1 }}>
                {fact.label}
              </Label>
              <Label size="footnote" style={{ fontVariant: ['tabular-nums'], flexShrink: 1 }}>
                {fact.value}
              </Label>
            </View>
          ))}
        </View>
      )}
      <Points points={item.good} good />
      <Points points={item.bad} good={false} />
    </View>
  )
}

/** Plus and minus marks carry the meaning without colour; text wraps at the phone's own width. */
function Points({ points, good }: { points: ReadonlyArray<string>; good: boolean }) {
  const { colors: c } = useTheme()
  const Icon = good ? Plus : Minus
  return points.map((point) => (
    <View
      key={point}
      accessible
      accessibilityLabel={`${good ? 'Good' : 'Not so good'}: ${point}`}
      style={{ flexDirection: 'row', gap: 8 }}
    >
      <Icon
        pointerEvents="none"
        size={14}
        strokeWidth={2.5}
        color={c[good ? 'status-success' : 'status-danger']}
        style={{ marginTop: 2 }}
      />
      <Label size="label" tone="ink-2" style={{ flex: 1 }}>
        {point}
      </Label>
    </View>
  ))
}
