import {
  action,
  defineComponent,
  reactive,
  useFormName,
  useIsStreaming,
  useStateField,
  useTriggerAction,
} from '@openuidev/react-lang'
import { createElement, useState, type ReactNode } from 'react'
import { StyleSheet, Text, TextInput, View, type ViewStyle } from 'react-native'
import { z } from 'zod/v4'
import {
  children,
  color,
  mix,
  option,
  radiusSchema,
  toOption,
  useInk,
  useSkin,
  type Option,
} from './style'
import { glyphOf } from './glyph'
import { Press } from '../ui/motion/Pressable'
import { Segmented } from '../ui/ui'

/**
 * The parts a finger answers (`apps/web/vendor/openui/controls.tsx`), drawn as React Native
 * controls. The schemas and the reactive plumbing are the web's own — the same hooks read and
 * write the renderer's fields — and a press is drawn with the app's own `Press`
 * (`apps/mobile/src/ui/motion/Pressable.tsx`), so a display's answers sink and rise the way every
 * other control in the app does. An enabled target answers at least 44 points under the finger,
 * even where the web draws it smaller.
 */
type Plan = Parameters<ReturnType<typeof useTriggerAction>>[2]

/** Runs an action prop. With no action and `sendLabel`, a button sends its own words to Vivid. */
function useRunAction() {
  const trigger = useTriggerAction()
  const formName = useFormName()
  return (message: string, plan: unknown, sendLabel: boolean) => {
    // With a plan, the plan carries its own words (`triggerAction` reads the step's message and
    // the form's fields); without one, only a button's own words are worth sending.
    if (plan) {
      void trigger(message, formName, plan as Plan)
      return
    }
    if (sendLabel) void trigger(message, formName)
  }
}

/**
 * The state key of a control: its label, else its statement's own name. The web falls back to
 * React's `useId`; the renderer gives every statement an id, so the two honest names cover every
 * drawn control. (The web's last resort — a generated id — has no phone reading, because a field
 * written outside any statement always carries one of the two.)
 */
const useFieldName = (label: unknown, statementId?: string) =>
  (typeof label === 'string' && label) || statementId || 'field'

/** A lucide icon, tinted for where it stands. An unknown name draws nothing, as the web's does. */
function Glyph({ name, size, tint }: { name: string; size: number; tint: string }) {
  const Icon = glyphOf(name)
  if (!Icon) return null
  return createElement(Icon, { pointerEvents: 'none', size, strokeWidth: 1.8, color: tint })
}

/** How one kind of button is painted in the skin in force. */
function buttonPaint(
  skin: ReturnType<typeof useSkin>,
  variant: 'solid' | 'outline' | 'soft' | 'ghost',
  kind: 'primary' | 'danger' | 'success',
) {
  const status = kind === 'primary' ? skin.accent : kind === 'danger' ? skin.danger : skin.success
  return {
    solid: { fill: status, on: skin.onAccent, line: false },
    soft: { fill: mix(status, skin.sheet, 0.14), on: status, line: false },
    outline: { fill: undefined, on: status, line: true },
    ghost: { fill: undefined, on: skin.muted, line: false },
  }[variant]
}

export const Button = defineComponent({
  name: 'Button',
  props: z.object({
    label: z.string(),
    action: action().optional(),
    variant: z.enum(['solid', 'outline', 'soft', 'ghost']).optional(),
    color: z.enum(['primary', 'danger', 'success']).optional(),
    size: z.enum(['sm', 'md', 'lg']).optional(),
    icon: z.string().optional(),
    disabled: z.boolean().optional(),
    block: z.boolean().optional(),
  }),
  description: 'icon is a lucide name.',
  component: ({ props }) => {
    const skin = useSkin()
    const run = useRunAction()
    const streaming = useIsStreaming()
    const label = props.label ?? ''
    const disabled = !!props.disabled || streaming
    // The app's own button shape, at the finger's height even at the `sm` size the web writes.
    const paint = buttonPaint(
      skin,
      props.variant ?? 'solid',
      props.color == null || props.color === 'primary' ? 'primary' : props.color,
    )
    const minHeight = props.size === 'sm' ? 38 : props.size === 'lg' ? 50 : 44
    return (
      <Press
        disabled={disabled}
        onPress={() => {
          if (!disabled) run(label, props.action, true)
        }}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        style={({ pressed }) => ({
          minHeight,
          alignSelf: props.block ? ('stretch' as const) : ('flex-start' as const),
          paddingHorizontal: 14,
          gap: 6,
          flexDirection: 'row' as const,
          alignItems: 'center' as const,
          justifyContent: 'center' as const,
          borderRadius: 12,
          backgroundColor: paint.fill,
          borderWidth: paint.line ? 1 : 0,
          borderColor: skin.border,
          opacity: disabled ? 0.55 : pressed && paint.fill == null ? 0.65 : 1,
        })}
      >
        {props.icon ? (
          <Glyph name={props.icon} size={props.size === 'sm' ? 14 : 16} tint={paint.on} />
        ) : null}
        <Text style={[styles.buttonText, { color: paint.on }]}>{label}</Text>
      </Press>
    )
  },
})

export const Pressable = defineComponent({
  name: 'Pressable',
  props: z.object({
    children,
    action: action().optional(),
    selected: z.boolean().optional(),
    padding: z.number().optional(),
    background: color.optional(),
    radius: radiusSchema.optional(),
  }),
  description: 'Makes any content clickable, such as a tile or a swatch.',
  component: ({ props, renderNode }) => {
    const skin = useSkin()
    const run = useRunAction()
    const streaming = useIsStreaming()
    const disabled = streaming
    const filled = skin.bg(props.background)
    // Clicks meant for a control inside the tile stay with that control on the web (`closest()`);
    // on the phone a nested control is drawn as its own pressable in front, which wins the touch
    // by responder order, so the tile answers a press on its own surface only.
    return (
      <Press
        disabled={disabled}
        onPress={() => {
          // The web names the answer from the tile's own text (`innerText`), which the phone has
          // no reading of. A display means a tile's answer to be its plan; with no plan nothing is
          // run, and with one the plan's own words are what Vivid is told (`display.tsx` never
          // sends an answer with no words).
          if (!disabled) run('', props.action, false)
        }}
        accessibilityRole="button"
        accessibilityState={{
          disabled,
          selected: props.selected == null ? undefined : props.selected !== null,
        }}
        style={({ pressed }) => ({
          padding: props.padding == null ? undefined : Math.max(0, props.padding) * 4,
          backgroundColor: filled,
          borderRadius: skin.radius(props.radius) ?? 16,
          borderWidth: filled == null ? 0 : 1,
          borderColor: skin.border,
          opacity: pressed && filled == null ? 0.7 : 1,
        })}
      >
        {props.selected ? (
          <View style={[styles.selectedRing, { borderColor: skin.accent }]} pointerEvents="none" />
        ) : null}
        <View>{renderNode(props.children)}</View>
      </Press>
    )
  },
})

/** A field's own shape in the skin in force: a quiet well with the app's hairline edge. */
function useFieldStyle(): ViewStyle {
  const skin = useSkin()
  return {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: skin.border,
    backgroundColor: mix(skin.accent, skin.sheet, 0.04),
    paddingHorizontal: 12,
    paddingVertical: 10,
  }
}

/** A field with its label above it, in one shape the app's own screens use. */
function Field({ label, children: content }: { label?: string; children: ReactNode }) {
  const skin = useSkin()
  if (!label) return <>{content}</>
  return (
    <View style={styles.labeled}>
      <Text style={[styles.fieldLabel, { color: skin.muted }]}>{label}</Text>
      {content}
    </View>
  )
}

export const Input = defineComponent({
  name: 'Input',
  props: z.object({
    value: reactive(z.union([z.string(), z.number()])),
    label: z.string().optional(),
    type: z.enum(['text', 'number']).optional(),
    placeholder: z.string().optional(),
  }),
  description: 'Text or number field; a number field stores numbers.',
  component: ({ props, statementId }) => {
    const skin = useSkin()
    const field = useStateField(useFieldName(props.label, statementId), props.value)
    const numeric = props.type === 'number'
    // A number field shows what is typed ("1." or "-") until it parses, as the web's does.
    const [draft, setDraft] = useState<string | null>(null)
    const stringOf = (value: unknown) =>
      typeof value === 'string'
        ? value
        : value == null
          ? ''
          : typeof value === 'number' && Number.isFinite(value)
            ? value.toLocaleString('en-US', { maximumFractionDigits: 2 })
            : ''
    return (
      <Field label={props.label}>
        <TextInput
          style={useFieldStyle()}
          keyboardType={numeric ? 'decimal-pad' : 'default'}
          value={draft ?? stringOf(field.value)}
          placeholder={props.placeholder}
          placeholderTextColor={skin.faint}
          accessibilityLabel={props.label ?? props.placeholder}
          onChangeText={(text) => {
            if (!numeric) {
              field.setValue(text)
              return
            }
            setDraft(text)
            const parsed = Number(text.replace(/,/g, ''))
            if (text.trim() === '') field.setValue(null as unknown as number)
            else if (Number.isFinite(parsed)) field.setValue(parsed)
          }}
          onBlur={() => setDraft(null)}
        />
      </Field>
    )
  },
})

/** A text area's thickness, from the rows the display asked to show before it writes: the one size that depends on a prop. */
const textareaHeight = (count: number) => ({ minHeight: count * 22 })

export const TextArea = defineComponent({
  name: 'TextArea',
  props: z.object({
    value: reactive(z.string()),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    rows: z.number().optional(),
  }),
  description: '',
  component: ({ props, statementId }) => {
    const skin = useSkin()
    const field = useStateField(useFieldName(props.label, statementId), props.value)
    return (
      <Field label={props.label}>
        <TextInput
          style={[
            useFieldStyle(),
            textareaHeight(Math.min(20, Math.max(2, Math.round(props.rows ?? 3)))),
          ]}
          multiline
          textAlignVertical="top"
          value={field.value == null ? '' : String(field.value)}
          placeholder={props.placeholder}
          placeholderTextColor={skin.faint}
          accessibilityLabel={props.label ?? props.placeholder}
          onChangeText={(value) => field.setValue(value)}
        />
      </Field>
    )
  },
})

const options = z.array(option)
const optionList = (value: unknown) =>
  Array.isArray(value) ? (value.flat() as Option[]).filter((o) => o != null).map(toOption) : []

export const Select = defineComponent({
  name: 'Select',
  props: z.object({
    value: reactive(z.string()),
    options,
    label: z.string().optional(),
    placeholder: z.string().optional(),
  }),
  description: 'Dropdown, for long option lists.',
  component: ({ props, statementId }) => {
    const skin = useSkin()
    const field = useStateField(useFieldName(props.label, statementId), props.value)
    const choices = optionList(props.options)
    const value = field.value == null ? '' : String(field.value)
    const drawn = choices.find((o) => o.value === value)
    const [open, setOpen] = useState(false)
    return (
      <Field label={props.label}>
        <View>
          <Press
            disabled={false}
            onPress={() => setOpen((shown) => !shown)}
            accessibilityRole="combobox"
            accessibilityLabel={props.label ?? props.placeholder}
            accessibilityState={{ expanded: open }}
            style={({ pressed }) => [
              useFieldStyle(),
              {
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Text style={{ color: drawn ? skin.ink : skin.faint }}>
              {drawn ? drawn.label : (props.placeholder ?? 'Choose…')}
            </Text>
            <Text style={{ color: skin.faint }}>{open ? '▲' : '▼'}</Text>
          </Press>
          {open && (
            <View
              style={[
                styles.choiceSheet,
                { borderColor: skin.border, backgroundColor: skin.sheet },
              ]}
            >
              {choices.map((o, i) => (
                <Press
                  key={`${o.value}-${i}`}
                  disabled={false}
                  onPress={() => {
                    setOpen(false)
                    field.setValue(o.value)
                  }}
                  accessibilityRole="menuitem"
                  style={({ pressed }) => ({
                    minHeight: 40,
                    justifyContent: 'center',
                    paddingHorizontal: 12,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Text style={{ color: o.value === value ? skin.accent : skin.ink }}>
                    {o.label}
                  </Text>
                </Press>
              ))}
            </View>
          )}
        </View>
      </Field>
    )
  },
})

export const SegmentedControl = defineComponent({
  name: 'SegmentedControl',
  props: z.object({ value: reactive(z.string()), options, block: z.boolean().optional() }),
  description: '2 to 4 short choices in a row.',
  component: ({ props, statementId }) => {
    const field = useStateField(useFieldName(undefined, statementId), props.value)
    const value = field.value == null ? '' : String(field.value)
    // The app's own segmented control reads for these: 2 to 4 short choices in a row.
    return (
      <View style={props.block ? styles.block : undefined}>
        <Segmented
          label="Choose one"
          value={value}
          options={optionList(props.options).map((o) => ({ value: o.value, label: o.label }))}
          onChange={(picked) => field.setValue(picked)}
        />
      </View>
    )
  },
})

export const Checkbox = defineComponent({
  name: 'Checkbox',
  props: z.object({
    checked: reactive(z.boolean()),
    label: z.string(),
    lineThrough: z.boolean().optional(),
  }),
  description: 'lineThrough strikes the label when checked, for to-do lists.',
  component: ({ props, statementId }) => {
    const skin = useSkin()
    const field = useStateField(useFieldName(props.label, statementId), props.checked)
    const checked = field.value === true
    return (
      <Press
        disabled={false}
        onPress={() => field.setValue(!checked)}
        accessibilityRole="checkbox"
        accessibilityLabel={props.label ?? ''}
        accessibilityState={{ checked }}
        style={({ pressed }) => ({
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          opacity: pressed ? 0.65 : 1,
        })}
      >
        <View
          style={[
            styles.tick,
            {
              borderColor: checked ? skin.accent : skin.border,
              backgroundColor: checked ? skin.accent : 'transparent',
            },
          ]}
        >
          {checked ? <Glyph name="check" size={13} tint={skin.onAccent} /> : null}
        </View>
        <Text
          style={{
            fontSize: 16,
            lineHeight: 23,
            color: skin.ink,
            textDecorationLine: checked && props.lineThrough ? 'line-through' : 'none',
          }}
        >
          {props.label ?? ''}
        </Text>
      </Press>
    )
  },
})

const choice = z.union([
  z.string(),
  z.object({ value: z.string(), label: z.string(), description: z.string().optional() }),
])
type Choice = { value: string; label: string; description?: string }
const choiceList = (value: unknown): Choice[] =>
  Array.isArray(value)
    ? (value.flat() as (string | Choice)[])
        .filter((o) => o != null)
        .map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
    : []

export const RadioGroup = defineComponent({
  name: 'RadioGroup',
  props: z.object({
    value: reactive(z.string()),
    options: z.array(choice),
    label: z.string().optional(),
    variant: z.enum(['list', 'pills', 'cards']).optional(),
  }),
  description: 'pills for short choices; cards for choices that need a description line.',
  component: ({ props, statementId }) => {
    const skin = useSkin()
    // The ring's ink, read once: on a raw-coloured background the readable ink stands in.
    const ringInk = useInk(undefined, skin)
    const field = useStateField(useFieldName(props.label, statementId), props.value)
    const value = field.value == null ? '' : String(field.value)
    const variant = props.variant ?? 'list'
    if (variant === 'pills') {
      return (
        <View style={styles.labeled}>
          {props.label ? (
            <Text style={[styles.fieldLabel, { color: skin.muted }]}>{props.label}</Text>
          ) : null}
          <View style={styles.pills}>
            {choiceList(props.options).map((o, i) => (
              <Press
                key={`${o.value}-${i}`}
                disabled={false}
                onPress={() => field.setValue(o.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: o.value === value }}
                style={({ pressed }) => ({
                  minHeight: 36,
                  paddingHorizontal: 12,
                  justifyContent: 'center',
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: o.value === value ? skin.accent : skin.border,
                  backgroundColor:
                    o.value === value ? mix(skin.accent, skin.sheet, 0.1) : 'transparent',
                  opacity: pressed && o.value !== value ? 0.65 : 1,
                })}
              >
                <Text style={{ color: o.value === value ? skin.accent : skin.ink }}>{o.label}</Text>
              </Press>
            ))}
          </View>
        </View>
      )
    }
    // `list` is one radio line each; `cards` are the same lines with a description under the
    // label, drawn as sheets so a card choice is picked up as one.
    return (
      <View style={styles.labeled}>
        {props.label ? (
          <Text style={[styles.fieldLabel, { color: skin.muted }]}>{props.label}</Text>
        ) : null}
        <View style={{ gap: 8 }}>
          {choiceList(props.options).map((o, i) => {
            const selected = o.value === value
            return (
              <Press
                key={`${o.value}-${i}`}
                disabled={false}
                onPress={() => field.setValue(o.value)}
                accessibilityRole="radio"
                accessibilityLabel={o.label}
                accessibilityState={{ selected }}
                style={({ pressed }) => ({
                  minHeight: 44,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  borderWidth: 1,
                  borderRadius: variant === 'cards' ? 12 : 999,
                  paddingVertical: variant === 'cards' ? 10 : 0,
                  paddingHorizontal: variant === 'cards' ? 12 : 4,
                  borderColor: selected ? skin.accent : skin.border,
                  backgroundColor:
                    selected && variant === 'cards'
                      ? mix(skin.accent, skin.sheet, 0.06)
                      : 'transparent',
                  opacity: pressed && !selected ? 0.65 : 1,
                })}
              >
                <View style={[styles.radio, { borderColor: selected ? skin.accent : ringInk }]}>
                  {selected && (
                    <View style={[styles.radioFill, { backgroundColor: skin.accent }]} />
                  )}
                </View>
                <View style={{ flexShrink: 1 }}>
                  <Text style={{ color: skin.ink }}>{o.label}</Text>
                  {o.description ? (
                    <Text style={{ color: skin.muted, fontSize: 14, lineHeight: 19 }}>
                      {o.description}
                    </Text>
                  ) : null}
                </View>
              </Press>
            )
          })}
        </View>
      </View>
    )
  },
})

const styles = StyleSheet.create({
  block: { alignSelf: 'stretch' as const },
  buttonText: { fontSize: 14, lineHeight: 19, fontWeight: '600' as const },
  selectedRing: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 16,
    borderWidth: 2,
  },
  labeled: { gap: 6 as const },
  fieldLabel: { fontSize: 12, lineHeight: 15, fontWeight: '500' as const },
  choiceSheet: {
    marginTop: 6,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden' as const,
  },
  pills: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6 },
  tick: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  radioFill: { width: 10, height: 10, borderRadius: 5 },
})
