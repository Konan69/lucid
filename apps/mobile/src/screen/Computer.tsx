import { useAtomRefresh, useAtomValue } from '@effect/atom-react'
import {
  ComputerState,
  type Computer as ComputerRecord,
  type ComputerHealth,
  type ComputerRecoveryRecord,
} from '@vivid/contracts'
import { health, liveStateOf } from '@vivid/state'
import { VividRpcClient } from '@vivid/client-runtime'
import { Effect, Option, Result, Schema } from 'effect'
import { useState, type ReactNode } from 'react'
import { Linking, ScrollView, View } from 'react-native'
import { Eye, Hand, MonitorPlay, Power } from 'lucide-react-native'
import { glassNote, screenNote, standingOf, viewerOf, viewerPermission } from '../data/computer'
import { commit } from '../data/haptics'
import { LiveState, useLive, useLiveData, type LiveData } from '../data/live'
import { useTheme } from '../theme'
import { NO_ACTIONS, StandingBar } from '../ui/Bar'
import { Screen } from '../ui/Screen'
import { drawsScreen, Live } from './computer/Live'
import { Button, Dot, EDGE, Face, Label, Notice, radius, styles } from '../ui/ui'
import { start } from '../data/app'
import { when } from '../data/when'
import { useNow } from '../data/foreground'
import { Section } from '../ui/List'

/**
 * Turning the computer on. The screen shows it starting at once, and puts it back with the reason
 * if the server refuses; when it does start, the server's own record replaces the guess.
 */
const turnOn = (data: LiveData) =>
  data.changing(
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
const turnOff = (data: LiveData) =>
  data.changing(
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
  data.changing(
    (client) => client.HoldComputer({ held }),
    () =>
      data.live.computer.expect((current) => ({
        computer: { ...current.computer, heldByPerson: held },
      })),
  )

/** There was no page to open, or the phone's browser would not open it. */
class ScreenUnopened extends Schema.TaggedError<ScreenUnopened>()(
  'ScreenUnopened',
  {},
  { title: 'The screen could not be opened' },
) {}

/**
 * Opening the machine's screen. The address of the provider's viewer is a permission that runs
 * out ten minutes after it is issued, and the live record on this page may be older than that, so
 * the server is asked for the Computer again at the press and the address it answers with is the
 * one opened. It goes to the system browser (`Linking.openURL`, as sign-in does): the viewer is a
 * web page and this app has no web view. That page has no way to only watch (its `stream.js`
 * takes touches and keys whoever holds the keyboard), unlike the web panel, whose frame takes no
 * input until the Person has taken over; so the page under the button says a touch there reaches
 * the computer. A Computer that stopped meanwhile, a screen with no
 * page, or a browser that would not open are all the same thing to the Person: it did not open.
 */
const watch = Effect.fn('Computer.watch')(function* () {
  const client = yield* VividRpcClient
  const { computer } = yield* client.GetComputer()
  const address = viewerOf(computer)
  if (Option.isNone(address)) return yield* new ScreenUnopened({})
  yield* Effect.tryPromise({
    try: () => Linking.openURL(address.value),
    catch: () => new ScreenUnopened({}),
  })
})

/**
 * Vivid's computer: a real machine that is this Person's alone. The screen says honestly where it
 * stands (not started, starting, running and who has the keyboard, off, or failed) and gives the
 * Person the controls that matter: turning it on and off, and
 * taking the keyboard and pointer, which stops Vivid acting on it until they hand it back.
 *
 * A running computer's screen is on the glass, live: the provider's own viewer page in a web
 * view (`computer/Live.tsx`), watched until the Person takes over and theirs to touch after. An
 * install from before the web view was in the app (below 0.3.0) keeps Vivid's face on the glass,
 * and "Watch its screen" opens the same page in the system browser (`watch`). The remote-
 * framebuffer screen the web panel can also draw (`ComputerScreen.Relay`) has no page to open.
 *
 * Everything on it is the live record. A press is shown at once and taken back, with the reason,
 * if the server refuses it.
 */
export function Computer() {
  const data = useLiveData()
  const state = useLive(data.live.computer)
  const computer = LiveState.$is('Ready')(state) ? Option.some(state.value.computer) : Option.none()
  return (
    <Screen>
      <StandingBar
        title="Vivid’s computer"
        standing={{
          words: Option.match(computer, {
            onNone: () => 'Looking for your computer…',
            onSome: (value) => standingOf(value).glass,
          }),
          tone: 'ink-3',
        }}
        present={[]}
        actions={NO_ACTIONS}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, styles.column, { flexGrow: 1, paddingTop: 12 }]}
      >
        {page(state)}
        <Health />
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
      <Said
        glass={<Face size={56} mood="thinking" />}
        on={false}
        title="One moment"
        detail="Looking for your computer."
      />
    ),
    Failed: () => (
      <Said
        glass={<Face size={56} mood="neutral" />}
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
  glass,
  on,
  title,
  detail,
}: {
  /** What is on the glass: Vivid's face saying how the machine is, or the machine's own screen. */
  glass: ReactNode
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
          // The machine's screen is cut to the glass's corners, as a picture in a frame is.
          overflow: 'hidden',
        }}
      >
        {glass}
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
  take: 'Couldn’t take over. Vivid still has the keyboard. Try again.',
  hand: 'Couldn’t hand back. You still have the keyboard. Try again.',
  watch: 'The screen could not be opened. Try again.',
} as const

/**
 * The way to the provider's viewer page in the system browser. It is the main press only where
 * it is the way to the screen at all: with the screen drawn on the glass it is the larger view,
 * and while the Person holds the keyboard the main press is handing back.
 */
function Watch({
  drawn,
  held,
  onPress,
}: {
  /** The screen is already on this page's glass. */
  drawn: boolean
  held: boolean
  onPress: () => void
}) {
  return (
    <Button
      kind={!drawn && !held ? 'primary' : 'plain'}
      icon={Eye}
      label={drawn ? 'Open in your browser' : 'Watch its screen'}
      onPress={onPress}
    />
  )
}

/** The computer as it stands, and the controls that go with where it stands. */
function Machine({ computer }: { computer: ComputerRecord }) {
  const data = useLiveData()
  const standing = standingOf(computer)
  const running = ComputerState.guards.Running(computer.state)
  const watchable = Option.isSome(viewerOf(computer))
  // The screen itself is on the glass where this install can draw a web page; where it cannot,
  // the glass keeps Vivid's face and the button below opens the screen in the browser.
  const live = Option.filter(viewerPermission(computer), drawsScreen)
  // The last press the server refused. It is about that press, so the next one takes it down.
  const [refused, setRefused] = useState<Option.Option<keyof typeof REFUSED>>(Option.none())

  /** Makes one change, felt as it is pressed, and says so here if the server refuses it. */
  function press(
    what: keyof typeof REFUSED,
    change: Effect.Effect<Result.Result<unknown, unknown>>,
  ) {
    return start(
      Effect.gen(function* () {
        commit()
        setRefused(Option.none())
        const result = yield* change
        if (Result.isFailure(result)) setRefused(Option.some(what))
      }),
    )
  }

  return (
    <>
      <Said
        glass={
          Option.isSome(live) ? (
            <Live
              // A new machine start has a new viewer; the one on the glass is not carried over.
              key={live.value.address}
              address={live.value.address}
              expiresAt={live.value.expiresAt}
              control={computer.heldByPerson}
            />
          ) : (
            <Face size={56} mood={standing.mood} />
          )
        }
        on={running}
        title={standing.title}
        detail={standing.detail}
      />
      {running && (
        <Label size="label" tone="ink-2" style={{ paddingHorizontal: 4 }}>
          {Option.isSome(live) ? glassNote(computer) : screenNote(computer)}
        </Label>
      )}
      {Option.isSome(refused) && <Notice message={REFUSED[refused.value]} />}
      <View style={{ gap: 8 }}>
        {Option.isSome(standing.start) && (
          <Button
            kind="primary"
            icon={MonitorPlay}
            label={standing.start.value}
            onPress={() => void press('start', turnOn(data))}
          />
        )}
        {watchable && (
          <Watch
            drawn={Option.isSome(live)}
            held={computer.heldByPerson}
            onPress={() => void press('watch', data.running(watch()))}
          />
        )}
        {running && (
          <>
            <Button
              kind={computer.heldByPerson ? 'primary' : 'plain'}
              icon={Hand}
              label={computer.heldByPerson ? 'Hand back' : 'Take over'}
              onPress={() =>
                void press(
                  computer.heldByPerson ? 'hand' : 'take',
                  hold(data, !computer.heldByPerson),
                )
              }
            />
            <Button
              kind="ghost"
              icon={Power}
              label="Turn off"
              onPress={() => void press('stop', turnOff(data))}
            />
          </>
        )}
      </View>
    </>
  )
}

/** The ink of a standing's dot. */
const TONE = {
  good: 'status-success',
  working: 'status-working',
  bad: 'status-danger',
  quiet: 'ink-3',
} as const satisfies Record<
  health.HealthTone,
  'status-success' | 'status-working' | 'status-danger' | 'ink-3'
>

/** The ink of an ability's dot. */
const ABLE = {
  works: 'status-success',
  idle: 'ink-3',
  broken: 'status-danger',
  unchecked: 'line-4',
} as const satisfies Record<
  health.AbilityState,
  'status-success' | 'ink-3' | 'status-danger' | 'line-4'
>

/**
 * How the computer is doing, under its controls: every part checked when the screen asks, what
 * Vivid can do on it now, and how Vivid fixes it. The steps are shown and never offered: recovery
 * is Vivid's alone, gentlest first (`health.LADDER`), so the Person reads what happened and what
 * comes next and is asked nothing. The same panel as the web's Settings (`VividComputer`,
 * `apps/web/src/screen/settings/Computers.tsx`).
 */
function Health() {
  const data = useLiveData()
  const checked = liveStateOf(useAtomValue(data.computerHealth))
  const recovered = liveStateOf(useAtomValue(data.computerRecovery))
  const again = useAtomRefresh(data.computerHealth)
  const againRecovered = useAtomRefresh(data.computerRecovery)
  return (
    <View style={{ gap: 12, marginTop: 12 }}>
      {LiveState.$match(checked, {
        Loading: () => (
          <Label size="label" tone="ink-3">
            Checking every part…
          </Label>
        ),
        Failed: () => (
          <Label size="label" tone="ink-3">
            Vivid could not check its computer just now.
          </Label>
        ),
        Ready: ({ value }) => (
          <Checked
            health={value}
            recovery={
              LiveState.$is('Ready')(recovered) ? Option.some(recovered.value) : Option.none()
            }
          />
        ),
      })}
      <Button
        kind="ghost"
        label="Check again"
        disabled={LiveState.$is('Loading')(checked)}
        onPress={() => {
          again()
          againRecovered()
        }}
      />
    </View>
  )
}

/** One reading: the standing, what Vivid can do, and how Vivid fixes it. */
function Checked({
  health: reading,
  recovery,
}: {
  health: ComputerHealth
  recovery: Option.Option<ComputerRecoveryRecord>
}) {
  const now = useNow()
  const at = (moment: number) => when(moment, now)
  const said = health.healthReading(reading, at)
  const abilities = health.abilitiesOf(reading)
  const next = health.nextStep(reading)
  const last = Option.flatMap(recovery, (record) => health.recoveryWords(record, at))
  return (
    <>
      <Section title="How it is doing">
        <View style={{ padding: 14, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Dot tone={TONE[said.tone]} />
            <Label size="footnote">{said.title}</Label>
          </View>
          <Label size="label" tone="ink-2">
            {said.detail}
          </Label>
          <Label size="caption" tone="ink-3" style={{ fontVariant: ['tabular-nums'] }}>
            Checked {at(reading.checkedAt)}
          </Label>
        </View>
      </Section>
      {abilities.length > 0 && (
        <Section title="What Vivid can do on it now">
          {abilities.map((ability) => (
            <View key={ability.name} style={{ flexDirection: 'row', gap: 10, padding: 14 }}>
              <View style={{ paddingTop: 6 }}>
                <Dot tone={ABLE[ability.state]} size={6} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Label size="label">{ability.name}</Label>
                <Label size="label" tone="ink-3">
                  {ability.detail}
                </Label>
              </View>
            </View>
          ))}
        </Section>
      )}
      <Section
        title="How Vivid fixes it"
        detail="By itself, gentlest step first, and only as far as it has to."
      >
        <View style={{ padding: 14, gap: 6 }}>
          {health.LADDER.map((step, place) => {
            const current = Option.contains(next, step)
            return (
              <View key={step} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Label size="label" tone="ink-3" style={{ width: 14, textAlign: 'right' }}>
                  {place}
                </Label>
                <Label
                  size="label"
                  tone={current ? 'ink' : 'ink-3'}
                  style={current ? { fontWeight: '600' } : undefined}
                >
                  {health.STEP_WORDS[step].doing}
                </Label>
                {current && (
                  <Label size="caption" tone="status-working">
                    Next
                  </Label>
                )}
              </View>
            )
          })}
          {Option.isSome(last) && (
            <Label
              accessibilityLiveRegion="polite"
              size="label"
              tone="ink-2"
              style={{ marginTop: 6 }}
            >
              {last.value}
            </Label>
          )}
        </View>
      </Section>
    </>
  )
}
