import { ComputerState, type Computer as ComputerRecord } from '@vivid/contracts'
import type { FaceMood } from '@vivid/marks'
import { Option, Result } from 'effect'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { Hand, MonitorPlay, Power } from 'lucide-react-native'
import { standingOf } from '../data/computer'
import { commit } from '../data/haptics'
import { LiveState, useLive, useLiveData, type LiveData } from '../data/live'
import { useTheme } from '../theme'
import { Header, Screen } from '../ui/Header'
import { Button, Dot, EDGE, Face, Label, Notice, radius, styles } from '../ui/ui'
import { useGo } from '../workspace'

/**
 * Turning the computer on. The screen shows it starting at once, and puts it back with the reason
 * if the server refuses; when it does start, the server's own record replaces the guess.
 */
const start = (data: LiveData) =>
  data.change(
    (client) => client.StartComputer(),
    () =>
      data.live.computer.expect((current) => ({
        computer: {
          ...current.computer,
          state: ComputerState.cases.Starting.make({ since: Date.now() }),
        },
      })),
  )

/** Turning it off. Its files and sign-ins outlive the machine, which is why nothing is asked. */
const stop = (data: LiveData) =>
  data.change(
    (client) => client.StopComputer(),
    () =>
      data.live.computer.expect((current) => ({
        computer: {
          ...current.computer,
          state: ComputerState.cases.Stopped.make({ since: Date.now() }),
        },
      })),
  )

/** Taking the keyboard and pointer, or handing them back. Vivid cannot act while a Person holds them. */
const hold = (data: LiveData, held: boolean) =>
  data.change(
    (client) => client.HoldComputer({ held }),
    () =>
      data.live.computer.expect((current) => ({
        computer: { ...current.computer, heldByPerson: held },
      })),
  )

/**
 * Vivid's computer: a real machine that is this Person's alone. The screen says honestly where it
 * stands (not started, starting, running and who has the keyboard, off, failed, or not set up on
 * this installation) and gives the Person the controls that matter: turning it on and off, and
 * taking the keyboard and pointer, which stops Vivid acting on it until they hand it back.
 *
 * What it does not do is show the machine's screen. The web panel draws that with a
 * remote-framebuffer client, or the provider's own viewer in a frame; the phone has neither (no
 * web view is among this app's dependencies), so a running computer says who has the keyboard
 * and where its screen can be watched, and does not pretend to be watching.
 *
 * Everything on it is the live record. A press is shown at once and taken back, with the reason,
 * if the server refuses it.
 */
export function Computer() {
  const data = useLiveData()
  const go = useGo()
  const state = useLive(data.live.computer)
  const computer = LiveState.$is('Ready')(state) ? Option.some(state.value.computer) : Option.none()
  return (
    <Screen>
      <Header
        title="Vivid’s computer"
        subtitle={Option.match(computer, {
          onNone: () => 'Looking for your computer…',
          onSome: (value) => standingOf(value).glass,
        })}
        onBack={go.goBack}
      />
      <ScrollView
        contentContainerStyle={[styles.page, styles.column, { flexGrow: 1, paddingTop: 12 }]}
      >
        {page(state)}
      </ScrollView>
    </Screen>
  )
}

/**
 * What the page shows for each state of the live record: that it is being looked for, that it
 * cannot be reached, or the machine itself. A live query fails only for good, and the reason it
 * gives is the server's, not something to act on here, so the Person is told what it means.
 */
const page = (state: LiveState<{ readonly computer: ComputerRecord }>) =>
  LiveState.$match(state, {
    Loading: () => (
      <Said mood="thinking" on={false} title="One moment" detail="Looking for your computer." />
    ),
    Failed: () => (
      <Said
        mood="neutral"
        on={false}
        title="Not available"
        detail="Vivid could not reach its computer right now."
      />
    ),
    Ready: ({ value }) => <Machine computer={value.computer} />,
  })

/**
 * The computer's glass with Vivid on it, and under it what that means. The glass has the shape of
 * the machine's own screen (16:10), so the place where the screen would be is where Vivid's face
 * says how the machine is: thinking while it starts, asleep while it is off.
 */
function Said({
  mood,
  on,
  title,
  detail,
}: {
  mood: FaceMood
  /** The machine is running, which the glass says in a word as well as a colour. */
  on: boolean
  title: string
  detail: string
}) {
  const { colors: c } = useTheme()
  return (
    <>
      <View
        style={{
          aspectRatio: 16 / 10,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radius.panel,
          borderWidth: EDGE,
          borderColor: c.border,
          backgroundColor: c['md-code-bg'],
        }}
      >
        {on && (
          <View
            style={{
              position: 'absolute',
              top: 14,
              left: 16,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Dot tone="status-success" size={7} />
            <Label size="caption" tone="ink-2">
              On
            </Label>
          </View>
        )}
        <Face size={56} mood={mood} />
      </View>
      <View accessibilityLiveRegion="polite" style={{ gap: 6, paddingHorizontal: 4 }}>
        <Label accessibilityRole="header" size="title" style={{ fontWeight: '600' }}>
          {title}
        </Label>
        <Label tone="ink-2">{detail}</Label>
      </View>
    </>
  )
}

/** What the Person is told when a press did not go through, by what they pressed. */
const REFUSED = {
  start: 'The computer could not be turned on. Try again.',
  stop: 'The computer could not be turned off. Try again.',
  take: 'Vivid still has the keyboard: taking over did not go through. Try again.',
  hand: 'You still have the keyboard: handing back did not go through. Try again.',
} as const

/** The computer as it stands, and the controls that go with where it stands. */
function Machine({ computer }: { computer: ComputerRecord }) {
  const data = useLiveData()
  const standing = standingOf(computer)
  const running = ComputerState.guards.Running(computer.state)
  // The last press the server refused. It is about that press, so the next one takes it down.
  const [refused, setRefused] = useState<Option.Option<keyof typeof REFUSED>>(Option.none())

  /** Makes one change, felt as it is pressed, and says so here if the server refuses it. */
  async function press(
    what: keyof typeof REFUSED,
    change: () => Promise<Result.Result<unknown, unknown>>,
  ) {
    commit()
    setRefused(Option.none())
    const result = await change()
    if (Result.isFailure(result)) setRefused(Option.some(what))
  }

  return (
    <>
      <Said mood={standing.mood} on={running} title={standing.title} detail={standing.detail} />
      {running && (
        <Label size="label" tone="ink-2" style={{ paddingHorizontal: 4 }}>
          Its screen is not shown on the phone. Open Vivid in a browser to watch it.
        </Label>
      )}
      {Option.isSome(refused) && <Notice message={REFUSED[refused.value]} />}
      <View style={{ gap: 8 }}>
        {Option.isSome(standing.start) && (
          <Button
            kind="primary"
            icon={MonitorPlay}
            label={standing.start.value}
            onPress={() => void press('start', () => start(data))}
          />
        )}
        {running && (
          <>
            <Button
              kind={computer.heldByPerson ? 'primary' : 'plain'}
              icon={Hand}
              label={computer.heldByPerson ? 'Hand back' : 'Take over'}
              onPress={() =>
                void press(computer.heldByPerson ? 'hand' : 'take', () =>
                  hold(data, !computer.heldByPerson),
                )
              }
            />
            <Button
              kind="ghost"
              icon={Power}
              label="Turn off"
              onPress={() => void press('stop', () => stop(data))}
            />
          </>
        )}
      </View>
    </>
  )
}
