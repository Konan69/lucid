import { Shown as ShownKind } from '@vivid/contracts'
import { siteOf } from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import { View } from 'react-native'
import {
  CheckCircle2,
  Circle,
  CircleDot,
  CircleSlash,
  ExternalLink,
  MapPin,
} from 'lucide-react-native'
import { useTheme } from '../../theme'
import { Pictures } from '../../ui/Pictures'
import { openWebLink } from '../../ui/Prose'
import { HAIRLINE, Label, Press, radius, type Tone } from '../../ui/ui'
import { Chart } from './Chart'
import { Comparison } from './Comparison'
import { Draft } from './Draft'
import { Form } from './Form'
import { Frame } from './Frame'
import { Options } from './Options'
import { Table } from './Table'

type Kind<Tag extends ShownKind['_tag']> = Extract<ShownKind, { readonly _tag: Tag }>
type Interactive = { readonly live: boolean; readonly onSay: (words: string) => void }

/**
 * What Vivid showed, drawn the way a phone reads each kind: sideways pages, sheets and rows
 * under a thumb rather than the web's columns and panels. The data and the words are the web's.
 */
export function Display({ shown, live, onSay }: { shown: ShownKind } & Interactive) {
  return ShownKind.match(shown, {
    Table: (table) => <Table table={table} />,
    Chart: (chart) => (
      <Frame title={chart.title}>
        <Chart chart={chart} />
      </Frame>
    ),
    Steps: (plan) => <StepsShown plan={plan} />,
    Options: (ask) => <Options ask={ask} live={live} onSay={onSay} />,
    Comparison: (comparison) => <Comparison comparison={comparison} />,
    Links: (list) => <LinksShown list={list} />,
    Facts: (board) => <FactsShown board={board} />,
    Draft: (draft) => <Draft draft={draft} live={live} onSay={onSay} />,
    Schedule: (schedule) => <ScheduleShown schedule={schedule} />,
    Form: (form) => <Form form={form} live={live} onSay={onSay} />,
    Pictures: (gallery) => <PicturesShown gallery={gallery} />,
  })
}

/** Shape and ink both distinguish each plan state, as on the web. */
const STEP = {
  'to do': { Icon: Circle, tone: 'ink-2', mark: 'ink-4' },
  doing: { Icon: CircleDot, tone: 'ink', mark: 'status-working' },
  done: { Icon: CheckCircle2, tone: 'ink-3', mark: 'status-success' },
  skipped: { Icon: CircleSlash, tone: 'ink-4', mark: 'ink-4' },
} as const satisfies Record<
  Kind<'Steps'>['steps'][number]['state'],
  { Icon: typeof Circle; tone: Tone; mark: Tone }
>

/** A plan reports its progress and keeps skipped steps as part of its record. */
function StepsShown({ plan }: { plan: Kind<'Steps'> }) {
  const { colors: c } = useTheme()
  return (
    <Frame title={plan.title}>
      <Label size="caption" tone="ink-3">
        {plan.steps.filter((step) => step.state === 'done').length} of {plan.steps.length} done
      </Label>
      <View style={{ gap: 14 }}>
        {plan.steps.map((step) => {
          const { Icon, tone, mark } = STEP[step.state]
          return (
            <View
              key={step.label}
              accessible
              // The mark is a picture; the state is also said, to a screen reader and in words.
              accessibilityLabel={`${step.label}, ${step.state}${step.detail === undefined ? '' : `. ${step.detail}`}`}
              style={{ flexDirection: 'row', gap: 12 }}
            >
              <Icon pointerEvents="none" size={20} strokeWidth={1.8} color={c[mark]} />
              <View style={{ flex: 1, gap: 2 }}>
                <Label
                  size="label"
                  tone={tone}
                  style={{ textDecorationLine: step.state === 'skipped' ? 'line-through' : 'none' }}
                >
                  {step.label}
                </Label>
                {step.detail !== undefined && (
                  <Label size="caption" tone="ink-3">
                    {step.detail}
                  </Label>
                )}
              </View>
            </View>
          )
        })}
      </View>
    </Frame>
  )
}

/** Links open through the app's existing web-link boundary, with a visible refusal. */
function LinksShown({ list }: { list: Kind<'Links'> }) {
  const { colors: c } = useTheme()
  const [unopened, setUnopened] = useState(false)
  return (
    <Frame title={list.title}>
      {list.links.map((link) => (
        <Press
          key={link.address}
          accessibilityRole="link"
          accessibilityHint="Opens in your browser"
          onPress={() => {
            setUnopened(false)
            void openWebLink(link.address).then((opened) => setUnopened(!opened))
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            gap: 12,
            minHeight: 56,
            paddingVertical: 10,
            alignItems: 'center',
            borderTopWidth: HAIRLINE,
            borderTopColor: c['line-2'],
            backgroundColor: pressed ? c['wash-pressed'] : 'transparent',
          })}
        >
          <View style={{ flex: 1 }}>
            <Label size="label">{link.title}</Label>
            <Label size="caption" tone="ink-3" numberOfLines={1}>
              {siteOf(link.address)}
            </Label>
            {link.note !== undefined && (
              <Label size="caption" tone="ink-2">
                {link.note}
              </Label>
            )}
          </View>
          <ExternalLink pointerEvents="none" size={16} color={c['ink-4']} />
        </Press>
      ))}
      {unopened && (
        <Label size="label" tone="status-danger">
          That link could not be opened.
        </Label>
      )}
    </Frame>
  )
}

const TONE = { good: 'status-success', bad: 'status-danger' } as const

/** Facts are tiles with the number as the loudest thing on them, two to a row. */
function FactsShown({ board }: { board: Kind<'Facts'> }) {
  const { colors: c } = useTheme()
  return (
    <Frame title={board.title}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {board.facts.map((fact) => (
          <View
            key={fact.label}
            accessible
            accessibilityLabel={`${fact.label}: ${fact.value}${fact.change === undefined ? '' : `, ${fact.change}`}`}
            style={{
              width: '48%',
              borderRadius: radius.control,
              padding: 12,
              gap: 4,
              backgroundColor: c['surface-2'],
            }}
          >
            <Label size="caption" tone="ink-3" numberOfLines={1}>
              {fact.label}
            </Label>
            <Label
              size="largeTitle"
              numberOfLines={1}
              adjustsFontSizeToFit
              style={{ fontVariant: ['tabular-nums'] }}
            >
              {fact.value}
            </Label>
            {fact.change !== undefined && (
              <Label size="caption" tone={fact.tone === undefined ? 'ink-3' : TONE[fact.tone]}>
                {fact.change}
              </Label>
            )}
          </View>
        ))}
      </View>
    </Frame>
  )
}

/**
 * An agenda in the platform's own idiom: the time in a gutter, and each event as a line with a
 * coloured bar down its side, as Calendar draws one. No cards and no timeline to follow; the
 * hairlines between events are the only structure.
 */
function ScheduleShown({ schedule }: { schedule: Kind<'Schedule'> }) {
  const { colors: c } = useTheme()
  return (
    <Frame title={schedule.title === undefined ? schedule.day : schedule.title}>
      {schedule.title !== undefined && schedule.day !== undefined && (
        <Label size="caption" tone="ink-3">
          {schedule.day}
        </Label>
      )}
      <View>
        {schedule.items.map((item) => (
          <View
            key={`${item.at}:${item.title}`}
            accessible
            accessibilityLabel={[
              item.until === undefined ? item.at : `${item.at} to ${item.until}`,
              item.title,
              item.where,
              item.note,
            ]
              .filter((part) => part !== undefined)
              .join('. ')}
            style={{
              flexDirection: 'row',
              gap: 12,
              paddingVertical: 12,
              borderTopWidth: HAIRLINE,
              borderTopColor: c['line-2'],
            }}
          >
            <View style={{ width: 64 }}>
              <Label size="label" style={{ fontVariant: ['tabular-nums'] }}>
                {item.at}
              </Label>
              {item.until !== undefined && (
                <Label size="caption" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
                  {item.until}
                </Label>
              )}
            </View>
            <View style={{ width: 3, borderRadius: 2, backgroundColor: c.accent }} />
            <View style={{ flex: 1, gap: 2 }}>
              <Label size="footnote">{item.title}</Label>
              {item.where !== undefined && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <MapPin pointerEvents="none" size={12} color={c['ink-3']} />
                  <Label size="caption" tone="ink-3" style={{ flexShrink: 1 }}>
                    {item.where}
                  </Label>
                </View>
              )}
              {item.note !== undefined && (
                <Label size="label" tone="ink-2">
                  {item.note}
                </Label>
              )}
            </View>
          </View>
        ))}
      </View>
    </Frame>
  )
}

/** Pictures use a horizontal native strip; a tap reads one image full-screen. */
function PicturesShown({ gallery }: { gallery: Kind<'Pictures'> }) {
  return (
    <Frame title={gallery.title}>
      <Pictures
        pictures={gallery.pictures.map((picture) => ({
          address: picture.address,
          caption: Option.fromUndefinedOr(picture.caption),
        }))}
      />
    </Frame>
  )
}
