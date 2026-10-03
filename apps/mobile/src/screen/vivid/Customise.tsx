import { Appearance, FaceHue, Look, VIVID_NAME_MAX, VividName, Workspace } from '@vivid/contracts'
import type { FaceMood } from '@vivid/marks'
import { Option, Schema } from 'effect'
import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { commit, tick } from '../../data/haptics'
import { refusalOf, useLiveData, useLiveValue } from '../../data/live'
import { saveAppearance, useAppearance } from '../../data/vivid'
import { useTheme } from '../../theme'
import { Face } from '../../ui/Face'
import { Sheet } from '../../ui/Sheet'
import { Button, EDGE, Field, GUTTER, Label, Notice, Press } from '../../ui/ui'

/** Every look there is to choose, in the order they are shown: the theme's own colour first. */
const LOOKS: ReadonlyArray<Look> = [
  Look.cases.Accent.make({}),
  ...FaceHue.literals.map((hue) => Look.cases.Hue.make({ hue })),
]

/** One word per look, to compare two of them and to key a list by. */
const keyOf = (look: Look) =>
  Look.match(look, {
    Accent: () => 'accent',
    Hue: ({ hue }) => hue,
  })

/** What a look is called to someone who cannot see it. */
const lookName = (look: Look) =>
  Look.match(look, {
    Accent: () => 'Theme colour',
    Hue: ({ hue }) => `${hue.charAt(0).toUpperCase()}${hue.slice(1)}`,
  })

const decodeName = Schema.decodeUnknownOption(VividName)

/** A swatch: the face at 56 inside a 68 target, so the ring of the chosen one has room. */
const SWATCH = 68
const SWATCH_FACE = 56
const PREVIEW = 148

/**
 * The sheet where Vivid is given a name and a colour, on a phone.
 *
 * The same choice as the web's Customise sheet (`apps/web/src/screen/vivid/Customise.tsx`),
 * which is adapted from ChatGPT's "Customize your dot", laid out for one hand instead of ported:
 * one column with the preview and the name at the top, the colours in a row that scrolls
 * sideways (the reference's `artwork-row`, without its arrow buttons: a finger scrolls a row),
 * and Save in the sheet's footer, in the thumb's reach and above the keyboard. It is the system's
 * own sheet, so it slides and swipes away as every other one does.
 *
 * Kept from the reference: the 24-character one-line name with no backslash, Done on the keyboard
 * saving, a colour selecting on tap, and the draft staying up with a message when the save does
 * not land. Its characters and pets are not here, for the reason given in the web sheet.
 *
 * Saving is optimistic: the moment Save is pressed every face and name behind the sheet changes
 * (`saveAppearance`), and the sheet closes when the server has taken it.
 */
export function Customise({ onClose }: { onClose: () => void }) {
  const data = useLiveData()
  const saved = useAppearance()
  const me = useLiveValue(data.live.me)
  const [name, setName] = useState<string>(saved.name)
  const [look, setLook] = useState(saved.look)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const text = name.trim()
  const unchanged = text === saved.name && keyOf(look) === keyOf(saved.look)
  // Everyone in a Company shares one Vivid, so the person changing it is told whose it is.
  const detail = Option.match(
    Option.map(me, (value) => value.workspace),
    {
      onNone: () => 'A name and a colour, shown wherever Vivid is.',
      onSome: (workspace) =>
        Workspace.match(workspace, {
          Personal: () => 'A name and a colour, shown wherever Vivid is.',
          Company: ({ company }) => `Everyone in ${company.name} sees this name and colour.`,
        }),
    },
  )

  async function save() {
    if (busy || unchanged) return
    const valid = decodeName(text)
    if (Option.isNone(valid)) {
      setRefused(Option.some(`Use 1 to ${VIVID_NAME_MAX} characters, without backslashes.`))
      return
    }
    setBusy(true)
    setRefused(Option.none())
    commit()
    const refusal = refusalOf(
      await saveAppearance(data, new Appearance({ name: valid.value, look })),
    )
    setBusy(false)
    if (Option.isNone(refusal)) onClose()
    else setRefused(refusal)
  }

  return (
    <Sheet
      title="Customise Vivid"
      detail={detail}
      onClose={onClose}
      footer={
        <Button
          morph
          kind="primary"
          label={busy ? 'One moment…' : 'Save'}
          disabled={busy || unchanged}
          onPress={() => void save()}
        />
      }
    >
      <Preview look={look} name={text.length > 0 ? text : 'Vivid'} />
      <Field
        value={name}
        accessibilityLabel="Name"
        placeholder="Vivid"
        maxLength={VIVID_NAME_MAX}
        autoCorrect={false}
        returnKeyType="done"
        editable={!busy}
        onChangeText={(next) => {
          setName(next)
          setRefused(Option.none())
        }}
        onSubmitEditing={() => void save()}
        style={{ textAlign: 'center' }}
      />
      {Option.isSome(refused) && <Notice message={refused.value} />}
      <Swatches
        chosen={look}
        disabled={busy}
        onChoose={(next) => {
          tick()
          setLook(next)
        }}
      />
    </Sheet>
  )
}

/**
 * Vivid as it will look. Not a control: it only looks back, leaning in while a finger is on it.
 * The tilt is the face's own transition (`ui/Face.tsx`), once per change, and still under
 * reduced motion.
 */
function Preview({ look, name }: { look: Look; name: string }) {
  const [mood, setMood] = useState<FaceMood>('neutral')
  return (
    <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
      <Pressable
        accessible={false}
        onPressIn={() => setMood('happy')}
        onPressOut={() => setMood('neutral')}
      >
        <Face size={PREVIEW} mood={mood} look={look} label={`${name}, as it will look`} />
      </Pressable>
    </View>
  )
}

/**
 * The colours, as faces, in one row that scrolls sideways. The row bleeds to the sheet's edges so
 * a swatch slides under them instead of stopping short at the gutter, and the chosen one is said
 * by a ring as well as by `selected`, not by colour alone.
 */
function Swatches({
  chosen,
  disabled,
  onChoose,
}: {
  chosen: Look
  disabled: boolean
  onChoose: (look: Look) => void
}) {
  const { colors: c } = useTheme()
  return (
    <View style={{ gap: 8 }}>
      <Label size="label" tone="ink-2" accessibilityRole="header">
        Colours
      </Label>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -GUTTER }}
        contentContainerStyle={{ paddingHorizontal: GUTTER - 6, gap: 4 }}
      >
        {LOOKS.map((option) => {
          const active = keyOf(option) === keyOf(chosen)
          return (
            <Press
              key={keyOf(option)}
              accessibilityRole="button"
              accessibilityLabel={lookName(option)}
              accessibilityState={{ selected: active, disabled }}
              disabled={disabled}
              onPress={() => onChoose(option)}
              style={{
                width: SWATCH,
                height: SWATCH,
                borderRadius: SWATCH / 2,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: EDGE * 2,
                borderColor: active ? c.foreground : 'transparent',
              }}
            >
              <Face size={SWATCH_FACE} look={option} label="" />
            </Press>
          )
        })}
      </ScrollView>
    </View>
  )
}
