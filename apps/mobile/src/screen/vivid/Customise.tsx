import {
  Appearance,
  FaceHue,
  FaceOutline,
  Look,
  VIVID_NAME_MAX,
  VividName,
  Workspace,
} from '@vivid/contracts'
import type { FaceMood } from '@vivid/marks'
import { Effect, Option, Schema } from 'effect'
import { useState, type ReactNode } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { commit, tick } from '../../data/haptics'
import { refusalOf, useLiveData, useLiveValue } from '../../data/live'
import { facePaintOf, saveAppearance, useAppearance } from '../../data/vivid'
import { useTheme } from '../../theme'
import { Face } from '../../ui/Face'
import { Sheet } from '../../ui/Sheet'
import { Button, EDGE, Field, GUTTER, Label, Notice, Press, radius } from '../../ui/ui'
import { start } from '../../data/app'

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

/** What an outline is called to someone who cannot see it. */
const outlineName = (outline: FaceOutline) =>
  `${outline.charAt(0).toUpperCase()}${outline.slice(1)}`

/** A colour: a 30 dot inside a 48 target, so the ring of the chosen one has room. */
const DOT_TARGET = 48
const DOT = 30
/** A shape: the face at 44 inside a 64 tile. */
const TILE = 64
const TILE_FACE = 44
const PREVIEW = 148

/**
 * The sheet where Vivid is given a name, a colour and a shape, on a phone.
 *
 * The same choices as the web's Customise sheet (`apps/web/src/screen/vivid/Customise.tsx`), laid
 * out for one hand instead of ported. The order is Grok Bot's "Create your first Bot" step (the
 * screenshot `refs/grok-bot-screenshots/03-create-your-first-bot.png`): the face large, a row of
 * plain colour dots with the chosen one ringed, a row of the eight shapes drawn in the chosen
 * colour with the chosen one in a ringed tile, then the name. Both rows scroll sideways under a
 * finger. Save is in the sheet's footer, in the thumb's reach and above the keyboard, and it is
 * the system's own sheet, so it slides and swipes away as every other one does.
 *
 * Kept from ChatGPT's "Customize your dot": the 24-character one-line name with no backslash,
 * Done on the keyboard saving, and the draft staying up with a message when the save fails.
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
  const [outline, setOutline] = useState(saved.outline)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<Option.Option<string>>(Option.none())
  const text = name.trim()
  const unchanged =
    text === saved.name && outline === saved.outline && keyOf(look) === keyOf(saved.look)
  // Everyone in a Company shares one Vivid, so the person changing it is told whose it is.
  const detail = Option.match(
    Option.map(me, (value) => value.workspace),
    {
      onNone: () => 'Vivid’s name, colour and shape, shown wherever it appears.',
      onSome: (workspace) =>
        Workspace.match(workspace, {
          Personal: () => 'Vivid’s name, colour and shape, shown wherever it appears.',
          Company: ({ company }) => `Everyone in ${company.name} sees this name and look.`,
        }),
    },
  )

  function save() {
    return start(
      Effect.gen(function* () {
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
          yield* saveAppearance(data, new Appearance({ name: valid.value, look, outline })),
        )
        setBusy(false)
        if (Option.isNone(refusal)) onClose()
        else setRefused(refusal)
      }),
    )
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
      <Preview look={look} outline={outline} name={text.length > 0 ? text : 'Vivid'} />
      <Colours
        chosen={look}
        disabled={busy}
        onChoose={(next) => {
          tick()
          setLook(next)
        }}
      />
      <Outlines
        chosen={outline}
        look={look}
        disabled={busy}
        onChoose={(next) => {
          tick()
          setOutline(next)
        }}
      />
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
    </Sheet>
  )
}

/**
 * Vivid as it will look. Not a control: it only looks back, leaning in while a finger is on it.
 * The tilt is the face's own transition (`ui/Face.tsx`), once per change, and still under
 * reduced motion.
 */
function Preview({ look, outline, name }: { look: Look; outline: FaceOutline; name: string }) {
  const [mood, setMood] = useState<FaceMood>('neutral')
  return (
    <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
      <Pressable
        accessible={false}
        onPressIn={() => setMood('happy')}
        onPressOut={() => setMood('neutral')}
      >
        <Face
          size={PREVIEW}
          mood={mood}
          look={look}
          outline={outline}
          label={`${name}, as it will look`}
        />
      </Pressable>
    </View>
  )
}

/** A row of choices that scrolls sideways and bleeds to the sheet's edges, under its heading. */
function ChoiceRow({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Label size="label" tone="ink-2" accessibilityRole="header">
        {heading}
      </Label>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginHorizontal: -GUTTER }}
        contentContainerStyle={{ paddingHorizontal: GUTTER - 6, gap: 4 }}
      >
        {children}
      </ScrollView>
    </View>
  )
}

/**
 * The colours, as plain dots (Grok Bot's row). The chosen one is said by a ring as well as by
 * `selected`, not by colour alone.
 */
function Colours({
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
    <ChoiceRow heading="Colour">
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
              width: DOT_TARGET,
              height: DOT_TARGET,
              borderRadius: DOT_TARGET / 2,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: EDGE * 2,
              borderColor: active ? c.primary : 'transparent',
            }}
          >
            <View
              style={{
                width: DOT,
                height: DOT,
                borderRadius: DOT / 2,
                backgroundColor: facePaintOf(option, c).fill,
              }}
            />
          </Press>
        )
      })}
    </ChoiceRow>
  )
}

/** The eight shapes, each drawn as Vivid's face in the colour that is chosen. */
function Outlines({
  chosen,
  look,
  disabled,
  onChoose,
}: {
  chosen: FaceOutline
  look: Look
  disabled: boolean
  onChoose: (outline: FaceOutline) => void
}) {
  const { colors: c } = useTheme()
  return (
    <ChoiceRow heading="Shape">
      {FaceOutline.literals.map((option) => {
        const active = option === chosen
        return (
          <Press
            key={option}
            accessibilityRole="button"
            accessibilityLabel={outlineName(option)}
            accessibilityState={{ selected: active, disabled }}
            disabled={disabled}
            onPress={() => onChoose(option)}
            style={{
              width: TILE,
              height: TILE,
              borderRadius: radius.control,
              borderCurve: 'continuous',
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: EDGE * 2,
              borderColor: active ? c.primary : 'transparent',
              backgroundColor: active ? c.subtle : 'transparent',
            }}
          >
            <Face size={TILE_FACE} look={look} outline={option} label="" />
          </Press>
        )
      })}
    </ChoiceRow>
  )
}
