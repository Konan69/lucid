import {
  ComputerHealth,
  ComputerProbeFailure,
  ComputerProbeObservation,
  ComputerProbeResult,
  ComputerRecoveryOutcome,
  ComputerRecoveryRecord,
  type ComputerProbe,
  type ComputerRecoveryStep,
} from '@vivid/contracts'
import { Option } from 'effect'

/**
 * How Vivid's Computer is doing, in a Person's words, for the web's Settings panel and the
 * phone's Computer screen: whether it is ready, what Vivid can do on it now, and what Vivid did
 * or will do to fix it.
 *
 * Health and recovery are the server's (`GetComputerHealth`, `GetComputerRecovery`); this file
 * only says them. Recovery is Vivid's alone (the owner's "no guardrails" rule for the Computer):
 * the panel shows each step without asking the Person anything, and offers no button for one.
 */

/** Whether the Computer's standing is good, on its way, or something to know about. */
export type HealthTone = 'good' | 'working' | 'bad' | 'quiet'

export interface HealthReading {
  readonly tone: HealthTone
  readonly title: string
  readonly detail: string
}

/** What went wrong in one component, as a Person reads it. */
const failureWords = (failure: ComputerProbeFailure): string =>
  ComputerProbeFailure.match(failure, {
    ProviderUnreachable: () => 'The service that runs it is not answering',
    ProviderAuthentication: () => 'The service that runs it refused Vivid’s key',
    ProviderCapacity: () => 'The service that runs it has no room right now',
    ProviderStartLimit: () => 'It was started too often today',
    ProviderOutgrown: () => 'It has outgrown its machine',
    ProviderStalled: () => 'The service that runs it stopped making progress',
    ProviderRefused: () => 'The service that runs it refused',
    RecordedFailure: () => 'It failed earlier',
    BindingUnresolved: () => 'Vivid cannot find its machine',
    SshUnreachable: () => 'Vivid cannot reach it',
    SshAuthentication: () => 'It did not accept Vivid’s key',
    SshHostMismatch: () => 'It did not prove it is the same machine',
    ReceiptLost: () => 'A step’s answer was lost',
    DiskFull: () => 'Its disk is full',
    InodesFull: () => 'It has no room for more files',
    DesktopSession: () => 'Its desktop is not running',
    DriverUnresponsive: () => 'Vivid’s control of its screen stopped answering',
    BrowserUnresponsive: () => 'Its browser stopped answering',
    BrowserAmbiguous: () => 'Its browser has a window Vivid cannot tell apart',
    BrowserPermission: () => 'Its browser is waiting on a permission',
    Network: () => 'It cannot reach the internet',
    InvalidObservation: () => 'It answered with something Vivid could not read',
  })

/** The probes that failed, as their words. */
const failed = (probes: ReadonlyArray<ComputerProbe>) =>
  probes.flatMap((probe) =>
    ComputerProbeResult.guards.Failed(probe.result) ? [failureWords(probe.result.failure)] : [],
  )

/** The Computer's standing in a title and a sentence. `at` writes a moment as the surface does. */
export const healthReading = (
  health: ComputerHealth,
  at: (moment: number) => string,
): HealthReading =>
  ComputerHealth.match(health, {
    Absent: (): HealthReading => ({
      tone: 'quiet',
      title: 'Not made yet',
      detail: 'Vivid makes it the first time it needs one.',
    }),
    Sleeping: (): HealthReading => ({
      tone: 'quiet',
      title: 'Asleep',
      detail: 'It wakes by itself when Vivid needs it. Its files and sign-ins are kept.',
    }),
    Starting: ({ since }): HealthReading => ({
      tone: 'working',
      title: 'Waking up',
      detail: `Starting since ${at(since)}.`,
    }),
    Held: (): HealthReading => ({
      tone: 'quiet',
      title: 'You have control',
      detail: 'Vivid waits until you hand it back.',
    }),
    Ready: ({ depth }): HealthReading => ({
      tone: 'good',
      title: 'Ready',
      detail:
        depth === 'Deep'
          ? 'Every part answered when it was checked.'
          : 'It is running. Its parts were not checked one by one.',
    }),
    Degraded: ({ probes }): HealthReading => ({
      tone: 'bad',
      title: 'Not working right',
      detail: `${failed(probes).join('. ')}. Vivid fixes this itself.`,
    }),
    Unavailable: ({ cause }): HealthReading => ({
      tone: 'bad',
      title: 'Out of reach',
      detail: `${failureWords(cause)}.`,
    }),
  })

// ── What Vivid can do on it ────────────────────────────────────────────────

/** Whether Vivid can do one thing on its Computer right now. */
export type AbilityState = 'works' | 'idle' | 'broken' | 'unchecked'

export interface Ability {
  readonly name: string
  readonly state: AbilityState
  readonly detail: string
}

/** A size in bytes as people say it: "12 GB". */
const size = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'gigabyte',
  maximumFractionDigits: 1,
})

/** The parts of the Computer that each thing Vivid does on it needs, in the order a Person reads. */
const ABILITIES = [
  { name: 'Run programs and work with files', parts: ['Ssh'] },
  { name: 'Use apps on its screen', parts: ['Desktop', 'Driver'] },
  { name: 'Browse the web', parts: ['Browser'] },
  { name: 'Reach the internet', parts: ['Network'] },
  { name: 'Room for files', parts: ['Disk'] },
] as const satisfies ReadonlyArray<{
  name: string
  parts: ReadonlyArray<ComputerProbe['component']>
}>

/** What one probe says about the ability that needs its part. */
const probeSays = (probe: ComputerProbe): Omit<Ability, 'name'> =>
  ComputerProbeResult.match(probe.result, {
    Passed: ({ observed }) => ({
      state: 'works' as const,
      detail: ComputerProbeObservation.guards.Disk(observed)
        ? `${size.format(Math.min(...observed.volumes.map((volume) => volume.availableBytes)) / 1e9)} free`
        : 'Works',
    }),
    Failed: ({ failure }) => ({ state: 'broken' as const, detail: failureWords(failure) }),
    NotRun: ({ reason }) =>
      reason === 'BrowserNotStarted'
        ? { state: 'idle' as const, detail: 'Opens when Vivid needs it' }
        : { state: 'unchecked' as const, detail: 'Not checked' },
  })

/** The worse of two states, so an ability is only as good as its weakest part. */
const RANK = { broken: 0, unchecked: 1, idle: 2, works: 3 } as const satisfies Record<
  AbilityState,
  number
>

/**
 * What Vivid can do on its Computer now, one line for each thing, from a deep check of its parts.
 * A reading that checked no parts (the Computer asleep, or only its service asked) has none.
 */
export const abilitiesOf = (health: ComputerHealth): ReadonlyArray<Ability> =>
  ComputerHealth.match(health, {
    Ready: ({ probes }) => abilitiesFrom(probes),
    Degraded: ({ probes }) => abilitiesFrom(probes),
    Absent: () => [],
    Sleeping: () => [],
    Starting: () => [],
    Held: () => [],
    Unavailable: () => [],
  })

/** Each ability from the parts it needs. A check of the service alone says nothing of them. */
const abilitiesFrom = (probes: ReadonlyArray<ComputerProbe>): ReadonlyArray<Ability> => {
  if (probes.length <= 1) return []
  return ABILITIES.map(({ name, parts }) => {
    const said = parts.map((part) =>
      Option.match(Option.fromUndefinedOr(probes.find((probe) => probe.component === part)), {
        onNone: () => ({ state: 'unchecked' as const, detail: 'Not checked' }),
        onSome: probeSays,
      }),
    )
    const worst = said.reduce((one, other) => (RANK[other.state] < RANK[one.state] ? other : one))
    return { name, ...worst }
  })
}

// ── How Vivid fixes it ─────────────────────────────────────────────────────

/** Each recovery step, as what it does to the Computer. */
export const STEP_WORDS = {
  Wake: { doing: 'Wake it', done: 'woke it' },
  Reconnect: { doing: 'Reconnect to it', done: 'reconnected to it' },
  RestartBrowser: { doing: 'Restart its browser', done: 'restarted its browser' },
  RestartDriver: { doing: 'Restart its screen control', done: 'restarted its screen control' },
  RestartDesktop: { doing: 'Restart its desktop', done: 'restarted its desktop' },
  Reboot: { doing: 'Restart the whole computer', done: 'restarted the whole computer' },
  Restore: { doing: 'Restore it from a backup', done: 'restored it from a backup' },
} as const satisfies Record<ComputerRecoveryStep, { doing: string; done: string }>

/**
 * The steps Vivid takes, gentlest first, each only when the one before it cannot fix what failed
 * ("recovered from the gentlest fix up", the capability scope of 29 October 2026). Steps 0 to 4 are Vivid's alone. Restarting the
 * desktop has no supervisor to do it yet and restoring has no backup to restore, so neither is
 * on the ladder (`unsupported` in `apps/server/src/computers/recovery.ts`).
 */
export const LADDER = [
  'Wake',
  'Reconnect',
  'RestartBrowser',
  'RestartDriver',
  'Reboot',
] as const satisfies ReadonlyArray<ComputerRecoveryStep>

/** The step that fixes each failing part, as the server admits it (`recovery.ts`). */
const FIXES = {
  Ssh: Option.some('Reconnect'),
  Browser: Option.some('RestartBrowser'),
  Driver: Option.some('RestartDriver'),
  Desktop: Option.some('Reboot'),
  Provider: Option.none(),
  Disk: Option.none(),
  Network: Option.none(),
} as const satisfies Record<ComputerProbe['component'], Option.Option<ComputerRecoveryStep>>

/**
 * The step Vivid takes next, from how the Computer stands: waking one that sleeps, else the
 * gentlest step that fixes a failing part. None when nothing is wrong or no step can help.
 */
export const nextStep = (health: ComputerHealth): Option.Option<(typeof LADDER)[number]> =>
  ComputerHealth.match(health, {
    Absent: () => Option.none(),
    Sleeping: () => Option.none(),
    Starting: () => Option.some('Wake' as const),
    Held: () => Option.none(),
    Ready: () => Option.none(),
    Unavailable: () => Option.none(),
    Degraded: ({ probes }) => {
      const steps = probes.flatMap((probe) =>
        ComputerProbeResult.guards.Failed(probe.result)
          ? Option.toArray(FIXES[probe.component])
          : [],
      )
      return Option.fromUndefinedOr(LADDER.find((step) => steps.includes(step)))
    },
  })

/**
 * The newest step Vivid took, in a sentence, when it took one. A step with no outcome is said as
 * begun, with its time: the server cannot tell a step still running from one a restart cut off.
 */
export const recoveryWords = (
  record: ComputerRecoveryRecord,
  at: (moment: number) => string,
): Option.Option<string> =>
  ComputerRecoveryRecord.match(record, {
    None: () => Option.none(),
    Unsettled: ({ step, since }) =>
      Option.some(
        `Vivid began to ${STEP_WORDS[step].doing.toLocaleLowerCase()} at ${at(since)}. No answer yet.`,
      ),
    Settled: ({ step, since, outcome }) =>
      Option.some(
        ComputerRecoveryOutcome.match(outcome, {
          Completed: () => `Vivid ${STEP_WORDS[step].done} at ${at(since)}.`,
          Refused: () =>
            `Vivid tried to ${STEP_WORDS[step].doing.toLocaleLowerCase()} at ${at(since)}; it was not the right step then.`,
          PersonRequired: ({ consequence }) =>
            `To ${STEP_WORDS[step].doing.toLocaleLowerCase()} needs you: ${consequence}`,
          Unsupported: () => `Vivid cannot ${STEP_WORDS[step].doing.toLocaleLowerCase()} yet.`,
          OutcomeUnknown: () =>
            `Vivid tried to ${STEP_WORDS[step].doing.toLocaleLowerCase()} at ${at(since)}; whether it worked is not known.`,
        }),
      ),
  })
