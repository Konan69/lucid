import {
  allowing,
  asking,
  deviceAnswers,
  deviceAsked,
  deviceQuestion,
  stopping,
  type DeviceAsked,
} from '@vivid/state'
import { Option } from 'effect'
import { useState } from 'react'
import type { SharedValue } from 'react-native-reanimated'
import { confirm, warn } from '../../data/haptics'
import { useLiveData, useLiveValue } from '../../data/live'
import { Attached, Surface, useSlide, useTallest } from './Banner'
import { Body, Head, Rows, Under } from './Choices'

/**
 * A computer whose desktop app is open and waiting to be allowed, asked about where the Person
 * already is: as a question's banner over the composer, on the first screen and in every Thread.
 * It is the phone's half of the web's `DeviceAsk` (`apps/web/src/screen/thread/Device.tsx`),
 * drawn as an Approval's banner is (`Allow.tsx`): the same surface, slide, head and rows.
 *
 * Which computer is asked about is `deviceAsked` (`@vivid/state`). A press sends the call
 * Settings sends on the web (`AllowDevice` or `RevokeDevice`) and lays what it will do over the
 * live list at once, so the computer is no longer waiting and the banner slides away; a refused
 * call puts the list back and the banner rises again. Until 16 October 2026 the phone had no
 * way to allow a computer at all.
 *
 * `free` is whether the place over the composer is this banner's: an Approval or a question that
 * is up comes first. The banner holds the computer it rose for until it has slid away.
 */
export function DeviceAsk({
  free,
  dock,
  covered,
}: {
  free: boolean
  /** The measured height of the composer's dock, which the banner is anchored to. */
  dock: number
  /** Written with how far the banner stands over what is under it (`useSlide`). */
  covered: SharedValue<number>
}) {
  const data = useLiveData()
  const devices = useLiveValue(data.live.devices)
  const up = free ? Option.flatMap(devices, (list) => deviceAsked(list.devices)) : Option.none()
  const [held, setHeld] = useState<Option.Option<DeviceAsked>>(Option.none())
  if (Option.isNone(held) && Option.isSome(up)) setHeld(up)
  if (Option.isNone(held)) return null
  // While it is still the one asked about, the newest record of it is drawn.
  const current = Option.filter(up, (now) => now.device.id === held.value.device.id)
  const shown = Option.getOrElse(current, () => held.value)

  /** Sends the answer, showing it at once over the live list. */
  const answer = (allow: boolean) => {
    const id = shown.device.id
    if (allow) confirm()
    else warn()
    void data.change(
      (client) => (allow ? client.AllowDevice({ id }) : client.RevokeDevice({ id })),
      () => data.live.devices.expect((allow ? allowing : stopping)(id, Date.now())),
    )
  }
  return (
    <Ask
      key={shown.device.id}
      asked={shown}
      leaving={Option.isNone(current)}
      dock={dock}
      covered={covered}
      onAnswer={answer}
      onGone={() => setHeld(Option.none())}
    />
  )
}

/** The banner itself: the question as its head, the two answers as rows under it. */
function Ask({
  asked,
  leaving,
  dock,
  covered,
  onAnswer,
  onGone,
}: {
  asked: DeviceAsked
  leaving: boolean
  dock: number
  covered: SharedValue<number>
  onAnswer: (allow: boolean) => void
  onGone: () => void
}) {
  const [open, setOpen] = useState(true)
  // The row pressed, by its label, kept only to show it chosen while the banner slides away.
  const [pressed, setPressed] = useState<Option.Option<string>>(Option.none())
  const tallest = useTallest(dock)
  const slide = useSlide(asking.standOf(leaving, !open), covered, onGone)
  const held = !open || leaving
  return (
    <Attached dock={dock} tallest={tallest} leaving={leaving} slide={slide}>
      <Surface tallest={tallest}>
        <Head
          words={deviceQuestion(asked.device)}
          count={Option.none()}
          says={{ hide: 'Hide the answers', show: 'Show the answers', place: '' }}
          open={open}
          disabled={leaving}
          onHeight={(height) => slide.head.set(height)}
          onToggle={() => setOpen(!open)}
        />
        <Body open={open}>
          <Under>
            <Rows
              rows={deviceAnswers(asked.instead).map((each) => ({
                option: { label: each.label, detail: each.detail },
                allow: each.allow,
                standing: asking.standingOf(
                  leaving && Option.contains(pressed, each.label),
                  leaving,
                ),
              }))}
              several={false}
              reach={held ? 'held' : 'pressable'}
              onPick={(row) => {
                setPressed(Option.some(row.option.label))
                onAnswer(row.allow)
              }}
            />
          </Under>
        </Body>
      </Surface>
    </Attached>
  )
}
