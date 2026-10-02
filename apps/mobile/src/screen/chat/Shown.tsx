import { Shown as ShownKind } from '@vivid/contracts'
import { DRAFT_WORDS, formReply, siteOf } from '@vivid/state'
import DateTimePicker from '@react-native-community/datetimepicker'
import { useState, type ReactNode } from 'react'
import { Image, Platform, ScrollView, View } from 'react-native'
import {
  Check,
  CheckCircle2,
  Circle,
  CircleDot,
  CircleSlash,
  ExternalLink,
  Minus,
  Plus,
} from 'lucide-react-native'
import { useTheme } from '../../theme'
import { Copy } from '../../ui/Copy'
import { openWebLink } from '../../ui/Prose'
import { Sheet } from '../../ui/Sheet'
import { Button, Field, HAIRLINE, Label, Press, radius, type Tone } from '../../ui/ui'
import { Chart } from './Chart'

type Kind<Tag extends ShownKind['_tag']> = Extract<ShownKind, { readonly _tag: Tag }>
type Interactive = { readonly live: boolean; readonly onSay: (words: string) => void }

/** The same eleven web displays, drawn locally from validated tool input with native controls. */
export function Display({ shown, live, onSay }: { shown: ShownKind } & Interactive) {
  return ShownKind.match(shown, {
    Table: (table) => <TableShown table={table} />,
    Chart: (chart) => (
      <Frame title={chart.title}>
        <Chart chart={chart} />
      </Frame>
    ),
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

/** A raised surface matches the web's frame and keeps wide content within the reply. */
function Frame({ title, children }: { title: Kind<'Table'>['title']; children: ReactNode }) {
  const { colors: c } = useTheme()
  return (
    <View
      style={{
        marginTop: 12,
        padding: 16,
        gap: 8,
        borderRadius: radius.card,
        backgroundColor: c['surface-3'],
        overflow: 'hidden',
      }}
    >
      {title !== undefined && (
        <Label accessibilityRole="header" size="footnote">
          {title}
        </Label>
      )}
      {children}
    </View>
  )
}

/** Horizontal scrolling preserves all columns instead of truncating the model's table. */
function TableShown({ table }: { table: Kind<'Table'> }) {
  const { colors: c } = useTheme()
  return (
    <Frame title={table.title}>
      <ScrollView horizontal>
        <View>
          <View
            style={{
              flexDirection: 'row',
              borderBottomWidth: HAIRLINE,
              borderBottomColor: c['line-3'],
            }}
          >
            {table.columns.map((column) => (
              <Label key={column} size="caption" tone="ink-3" style={{ width: 140, padding: 8 }}>
                {column}
              </Label>
            ))}
          </View>
          {table.rows.map((row, at) => (
            <View
              // Rows have no identity but their place, and the table is drawn once.
              // oxlint-disable-next-line react/no-array-index-key
              key={at}
              style={{
                flexDirection: 'row',
                borderBottomWidth: HAIRLINE,
                borderBottomColor: c['line-2'],
              }}
            >
              {table.columns.map((column, cell) => (
                <Label
                  key={column}
                  selectable
                  size="label"
                  style={{ width: 140, padding: 8, fontVariant: ['tabular-nums'] }}
                >
                  {row[cell]}
                </Label>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {table.note !== undefined && (
        <Label size="caption" tone="ink-3">
          {table.note}
        </Label>
      )}
    </Frame>
  )
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

/** A plan reports its progress and retains skipped steps as part of its record. */
function StepsShown({ plan }: { plan: Kind<'Steps'> }) {
  const { colors: c } = useTheme()
  return (
    <Frame title={plan.title}>
      <Label size="caption" tone="ink-3">
        {plan.steps.filter((step) => step.state === 'done').length} of {plan.steps.length} done
      </Label>
      {plan.steps.map((step) => {
        const { Icon, tone, mark } = STEP[step.state]
        return (
          <View key={step.label} style={{ flexDirection: 'row', gap: 10 }}>
            <Icon size={16} color={c[mark]} style={{ marginTop: 2 }} />
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
    </Frame>
  )
}

/** A choice says its label; multiple choices preserve selection order in the next message. */
function OptionsShown({ ask, live, onSay }: { ask: Kind<'Options'> } & Interactive) {
  const { colors: c } = useTheme()
  const [picked, setPicked] = useState<ReadonlyArray<string>>([])
  const pick = (label: string) => {
    if (!ask.many) return onSay(label)
    setPicked((now) => (now.includes(label) ? now.filter((one) => one !== label) : [...now, label]))
  }
  return (
    <Frame title={ask.question}>
      {ask.options.map((option) => {
        const on = picked.includes(option.label)
        return (
          <Press
            key={option.label}
            accessibilityRole="button"
            accessibilityState={{ disabled: !live, selected: ask.many && on }}
            disabled={!live}
            onPress={() => pick(option.label)}
            style={({ pressed }) => ({
              minHeight: 44,
              padding: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              borderRadius: radius.control,
              backgroundColor: pressed ? c['wash-pressed'] : c[on ? 'accent-soft' : 'surface-2'],
              opacity: live ? 1 : 0.6,
            })}
          >
            {ask.many && (
              <View
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  borderWidth: HAIRLINE,
                  borderColor: c['line-4'],
                  backgroundColor: on ? c.accent : 'transparent',
                }}
              >
                {on && <Check size={14} color={c['ink-on-accent']} />}
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Label size="label">{option.label}</Label>
              {option.detail !== undefined && (
                <Label size="caption" tone="ink-3">
                  {option.detail}
                </Label>
              )}
            </View>
          </Press>
        )
      })}
      {ask.many && live && (
        <Button
          kind="primary"
          label={picked.length === 0 ? 'Pick at least one' : `Send ${picked.length}`}
          disabled={picked.length === 0}
          onPress={() => onSay(picked.join(', '))}
          containerStyle={{ alignSelf: 'flex-start' }}
        />
      )}
    </Frame>
  )
}

/** Side-by-side alternatives scroll horizontally and keep the web's pick and rationale. */
function ComparisonShown({ comparison }: { comparison: Kind<'Comparison'> }) {
  const { colors: c } = useTheme()
  return (
    <Frame title={comparison.title}>
      <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
        {comparison.items.map((item) => {
          const picked = comparison.pick !== undefined && comparison.pick.name === item.name
          return (
            <View
              key={item.name}
              style={{
                width: 240,
                padding: 12,
                gap: 8,
                borderRadius: radius.control,
                backgroundColor: c[picked ? 'accent-soft' : 'surface-2'],
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Label size="label" style={{ flex: 1 }}>
                  {item.name}
                </Label>
                {picked && (
                  <Label
                    size="caption"
                    tone="ink-on-accent"
                    style={{
                      backgroundColor: c.accent,
                      borderRadius: radius.control,
                      paddingHorizontal: 8,
                    }}
                  >
                    Vivid’s pick
                  </Label>
                )}
              </View>
              {item.summary !== undefined && (
                <Label size="caption" tone="ink-3">
                  {item.summary}
                </Label>
              )}
              <Points points={item.good} good />
              <Points points={item.bad} good={false} />
              {item.facts.map((fact) => (
                <View
                  key={fact.label}
                  style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}
                >
                  <Label size="caption" tone="ink-3" style={{ flexShrink: 1 }}>
                    {fact.label}
                  </Label>
                  <Label
                    size="caption"
                    style={{ flexShrink: 1, textAlign: 'right', fontVariant: ['tabular-nums'] }}
                  >
                    {fact.value}
                  </Label>
                </View>
              ))}
            </View>
          )
        })}
      </ScrollView>
      {comparison.pick !== undefined && (
        <Label size="label" tone="ink-2">
          {comparison.pick.why}
        </Label>
      )}
    </Frame>
  )
}

/** A plus or minus carries the comparison's meaning even without its colour. */
function Points({ points, good }: { points: ReadonlyArray<string>; good: boolean }) {
  const { colors: c } = useTheme()
  const Icon = good ? Plus : Minus
  return points.map((point) => (
    <View key={point} style={{ flexDirection: 'row', gap: 6 }}>
      <Icon
        size={12}
        strokeWidth={2.5}
        color={c[good ? 'status-success' : 'status-danger']}
        style={{ marginTop: 2 }}
      />
      <Label size="caption" tone="ink-2" style={{ flex: 1 }}>
        {point}
      </Label>
    </View>
  ))
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
          onPress={() => {
            setUnopened(false)
            void openWebLink(link.address).then((opened) => setUnopened(!opened))
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            gap: 12,
            minHeight: 44,
            paddingVertical: 8,
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
          <ExternalLink size={14} color={c['ink-4']} style={{ marginTop: 4 }} />
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

/** Facts use the web's two-column small-screen grid, including the supplied movement tone. */
function FactsShown({ board }: { board: Kind<'Facts'> }) {
  const { colors: c } = useTheme()
  return (
    <Frame title={board.title}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {board.facts.map((fact) => (
          <View
            key={fact.label}
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
            <Label size="title" style={{ fontVariant: ['tabular-nums'] }}>
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

/** Draft actions speak in the Thread; copying remains available on historical drafts. */
function DraftShown({ draft, live, onSay }: { draft: Kind<'Draft'> } & Interactive) {
  const { colors: c } = useTheme()
  const words = DRAFT_WORDS[draft.kind]
  return (
    <Frame title={words.name}>
      {draft.to.length > 0 && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Label size="label" tone="ink-3" style={{ width: 56 }}>
            To
          </Label>
          <Label size="label" style={{ flex: 1 }}>
            {draft.to.join(', ')}
          </Label>
        </View>
      )}
      {draft.subject !== undefined && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Label size="label" tone="ink-3" style={{ width: 56 }}>
            Subject
          </Label>
          <Label size="label" style={{ flex: 1 }}>
            {draft.subject}
          </Label>
        </View>
      )}
      <ScrollView
        style={{ maxHeight: 320, borderRadius: radius.control, backgroundColor: c['surface-well'] }}
        contentContainerStyle={{ padding: 12 }}
        nestedScrollEnabled
      >
        <Label selectable size="label">
          {draft.body}
        </Label>
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {live && (
          <Button kind="primary" label={words.send} onPress={() => onSay(`${words.send}.`)} />
        )}
        <View style={{ flex: 1 }} />
        <Copy name="the draft" read={() => draft.body} />
      </View>
    </Frame>
  )
}

/** Times remain exactly as supplied, with location and notes beside each scheduled item. */
function ScheduleShown({ schedule }: { schedule: Kind<'Schedule'> }) {
  const { colors: c } = useTheme()
  return (
    <Frame title={schedule.title === undefined ? schedule.day : schedule.title}>
      {schedule.title !== undefined && schedule.day !== undefined && (
        <Label size="caption" tone="ink-3">
          {schedule.day}
        </Label>
      )}
      {schedule.items.map((item) => (
        <View
          key={`${item.at}:${item.title}`}
          style={{
            flexDirection: 'row',
            gap: 12,
            paddingVertical: 8,
            borderBottomWidth: HAIRLINE,
            borderBottomColor: c['line-2'],
          }}
        >
          <View style={{ width: 80 }}>
            <Label size="label" tone="ink-2">
              {item.at}
            </Label>
            {item.until !== undefined && (
              <Label size="caption" tone="ink-3">
                {item.until}
              </Label>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Label size="label">{item.title}</Label>
            {item.where !== undefined && (
              <Label size="caption" tone="ink-3">
                {item.where}
              </Label>
            )}
            {item.note !== undefined && (
              <Label size="caption" tone="ink-2">
                {item.note}
              </Label>
            )}
          </View>
        </View>
      ))}
    </Frame>
  )
}

/** Every field owns its unsent text; defaults match the browser's empty inputs and first choice. */
function FormShown({ form, live, onSay }: { form: Kind<'Form'> } & Interactive) {
  const [values, setValues] = useState(
    () =>
      new Map(
        form.fields.map((field) => [
          field.label,
          field.kind === 'choice' && field.choices.length > 0 ? field.choices[0] : '',
        ]),
      ),
  )
  return (
    <Frame title={form.title}>
      {form.fields.map((field) => {
        const value = values.get(field.label)
        if (value === undefined) throw new Error('A displayed form field has no value')
        return (
          <View key={field.label} style={{ gap: 6 }}>
            <Label size="caption" tone="ink-2">
              {field.label}
            </Label>
            <FormField
              field={field}
              value={value}
              disabled={!live}
              onChange={(next) => setValues((now) => new Map(now).set(field.label, next))}
            />
          </View>
        )
      })}
      {live && (
        <Button
          kind="primary"
          label={form.submit}
          onPress={() => {
            const words = formReply([...values].map(([label, value]) => ({ label, value })))
            if (words.length > 0) onSay(words)
          }}
          containerStyle={{ alignSelf: 'flex-start' }}
        />
      )}
    </Frame>
  )
}

/** Choices use the existing native sheet, text uses Field, and dates use the installed picker. */
function FormField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: Kind<'Form'>['fields'][number]
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  if (field.kind === 'choice')
    return <Choice field={field} value={value} disabled={disabled} onChange={onChange} />
  if (field.kind === 'date')
    return <DateField field={field} value={value} disabled={disabled} onChange={onChange} />
  return (
    <Field
      accessibilityLabel={field.label}
      value={value}
      placeholder={field.example}
      editable={!disabled}
      multiline={field.kind === 'long text'}
      keyboardType={field.kind === 'number' ? 'numeric' : 'default'}
      onChangeText={onChange}
      style={{ minHeight: field.kind === 'long text' ? 88 : 44, opacity: disabled ? 0.6 : 1 }}
    />
  )
}

/** A choice field selects one supplied label and leaves old forms readable but disabled. */
function Choice({
  field,
  value,
  disabled,
  onChange,
}: {
  field: Kind<'Form'>['fields'][number]
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button label={value} disabled={disabled} onPress={() => setOpen(true)} />
      {open && !disabled && (
        <Sheet title={field.label} onClose={() => setOpen(false)}>
          {field.choices.map((choice) => (
            <Button
              key={choice}
              label={choice}
              onPress={() => {
                onChange(choice)
                setOpen(false)
              }}
            />
          ))}
        </Sheet>
      )}
    </>
  )
}

/** Opening a calendar does not fill the field; only a selection contributes an ISO date. */
function DateField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: Kind<'Form'>['fields'][number]
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const { colors: c } = useTheme()
  const [open, setOpen] = useState(false)
  // Today is only the empty calendar's cursor; opening never supplies an answer for the Person.
  const [cursor, setCursor] = useState(() => new Date())
  const picker = (
    <DateTimePicker
      value={value.length === 0 ? cursor : new Date(`${value}T12:00:00`)}
      mode="date"
      onDismiss={() => setOpen(false)}
      onValueChange={(_event, date) => {
        setCursor(date)
        // Local components keep the selected day from moving through UTC at the wire boundary.
        onChange(
          `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        )
        if (Platform.OS === 'android') setOpen(false)
      }}
    />
  )
  return (
    <>
      <Press
        accessibilityRole="button"
        accessibilityLabel={field.label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          minHeight: 44,
          padding: 12,
          borderRadius: radius.control,
          backgroundColor: pressed ? c['wash-pressed'] : c['surface-well'],
          opacity: disabled ? 0.6 : 1,
        })}
      >
        <Label size="label" tone={value.length === 0 ? 'ink-4' : 'ink'}>
          {value.length === 0 ? field.example : value}
        </Label>
      </Press>
      {open &&
        !disabled &&
        (Platform.OS === 'ios' ? (
          <Sheet title={field.label} onClose={() => setOpen(false)}>
            {picker}
          </Sheet>
        ) : (
          picker
        ))}
    </>
  )
}

/** The web's small-screen gallery is two columns, with each supplied caption retained. */
function PicturesShown({ gallery }: { gallery: Kind<'Pictures'> }) {
  const { colors: c } = useTheme()
  return (
    <Frame title={gallery.title}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {gallery.pictures.map((picture) => (
          <View key={picture.address} style={{ width: '48%', gap: 4 }}>
            <Image
              source={{ uri: picture.address }}
              accessibilityLabel={picture.caption}
              accessible={picture.caption !== undefined}
              resizeMode="cover"
              style={{
                width: '100%',
                aspectRatio: 1,
                borderRadius: radius.control,
                backgroundColor: c['surface-2'],
              }}
            />
            {picture.caption !== undefined && (
              <Label size="caption" tone="ink-3" numberOfLines={1}>
                {picture.caption}
              </Label>
            )}
          </View>
        ))}
      </View>
    </Frame>
  )
}
