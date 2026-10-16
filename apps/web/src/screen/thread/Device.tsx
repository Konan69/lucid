import type { Device as Computer } from '@vivid/contracts'
import {
  allowing,
  asking,
  deviceAnswers,
  deviceAsked,
  deviceQuestion,
  stopping,
  type DeviceAsked as Asked,
} from '@vivid/state'
import { Effect, Option } from 'effect'
import { useId, useState } from 'react'
import { act } from '../../data/app'
import { nudgeThisComputer } from '../../data/computers'
import { changing, live, useLiveValue } from '../../data/live'
import { Attached, Head, Panel, Row, SURFACE, digits, steer, type Reach } from './Choices'

/**
 * A computer whose desktop app is open and waiting to be allowed, asked about where the Person
 * already is: as a question's banner attached to the top of the composer, on the first screen
 * and in every Thread. It is the same banner an Approval is (`Allow.tsx`), because the owner
 * settled on 12 October 2026 that anything Vivid asks first is "a normal question": a head that
 * says it, and the answers as rows.
 *
 * Which computer is asked about is `deviceAsked` (`@vivid/state`), read from the live list of the
 * Person's computers. A press sends the same call Settings > Computers sends (`AllowDevice` or
 * `RevokeDevice`) and lays what it will do over the live list at once, so the computer is no
 * longer waiting, the banner folds away, and the desktop app is told to look now. If the server
 * does not take it the list goes back and the banner rises again, asking the same thing.
 *
 * `free` is whether the place over the composer is this banner's: an Approval or a question that
 * is up comes first, since Vivid is waiting on that in this Thread.
 *
 * The banner holds the computer it was raised for until it has folded away, as `useAllowing`
 * holds an Approval: a computer answered here or on another device folds away, and the next one
 * rises after it.
 */
export function DeviceAsk({ free }: { free: boolean }) {
  const devices = useLiveValue(live.devices)
  const up = free ? Option.flatMap(devices, deviceAsked) : Option.none()
  const [held, setHeld] = useState<Option.Option<Asked>>(Option.none())
  if (Option.isNone(held) && Option.isSome(up)) setHeld(up)
  if (Option.isNone(held)) return null
  // While it is still the one asked about, the newest record of it is drawn.
  const current = Option.filter(up, (now) => now.device.id === held.value.device.id)
  const shown = Option.getOrElse(current, () => held.value)
  return (
    <Attached
      key={shown.device.id}
      leaving={Option.isNone(current)}
      refusal={Option.none()}
      onGone={() => setHeld(Option.none())}
    >
      <Ask asked={shown} held={Option.isNone(current)} />
    </Attached>
  )
}

/** Sends the Person's answer about one computer, showing it at once over the live list. */
const answer = (device: Computer, allow: boolean) =>
  act(
    Effect.gen(function* () {
      const id = device.id
      yield* changing(
        (client) => (allow ? client.AllowDevice({ id }) : client.RevokeDevice({ id })),
        () => live.devices.expect((allow ? allowing : stopping)(id, Date.now())),
      )
      // The desktop app hears of the decision now, instead of on its next scheduled look.
      yield* nudgeThisComputer
    }),
  )

/**
 * The banner's surface: the question as its head, and the two answers as rows under it. Which
 * row was pressed is kept only to show it chosen while the banner folds away.
 */
function Ask({ asked, held }: { asked: Asked; held: boolean }) {
  const panel = useId()
  const [open, setOpen] = useState(true)
  const [pressed, setPressed] = useState<Option.Option<string>>(Option.none())
  const answers = deviceAnswers(asked.instead)
  const reach: Reach = held || !open ? 'held' : 'pressable'
  const pick = (label: string) => {
    const chosen = answers.find((each) => each.label === label)
    if (chosen === undefined) return
    setPressed(Option.some(label))
    void answer(asked.device, chosen.allow)
  }
  return (
    <section aria-label="Vivid asks first" className={SURFACE} onKeyDown={steer}>
      <Head
        words={deviceQuestion(asked.device)}
        count={Option.none()}
        open={open}
        panel={panel}
        onToggle={() => setOpen((shown) => !shown)}
      />
      <Panel id={panel} open={open}>
        <ul className="mt-2 flex min-w-0 flex-col gap-0.5 ps-8 pe-1 pb-1 sm:ps-7">
          {answers.map((option, place) => (
            <Row
              key={option.label}
              option={option}
              digit={place + 1}
              several={false}
              reach={reach}
              standing={asking.standingOf(held && Option.contains(pressed, option.label), held)}
              onPress={() => pick(option.label)}
            />
          ))}
        </ul>
      </Panel>
      {/* There only while the rows can be pressed: see `digits`. */}
      {reach === 'pressable' && <span hidden ref={digits(answers, pick)} />}
    </section>
  )
}
