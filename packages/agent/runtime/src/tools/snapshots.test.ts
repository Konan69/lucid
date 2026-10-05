import { describe, expect, it } from '@effect/vitest'
import { PersonId, ThreadId } from '@vivid/contracts'
import { Effect, Option } from 'effect'
import { NoteFile, NoteIndex, NoteLine } from '../notes.ts'
import { contextSnapshots, Remembered, VividContext } from './snapshots.ts'

/** A context whose memory is one note with this description; the snapshots only carry it. */
const remembers = (description: string) =>
  Remembered.cases.Notes.make({
    index: NoteIndex.make({
      lines: [NoteLine.make({ file: NoteFile.make('a-fact.md'), kind: 'fact', description })],
      more: false,
    }),
  })

const ada = { threadId: ThreadId.make('shared'), personId: PersonId.make('ada') }
const dami = { threadId: ada.threadId, personId: PersonId.make('dami') }
const adaContext = VividContext.make({
  memory: remembers('Ada’s facts'),
  skills: [],
  timezone: 'Africa/Lagos',
  asOf: Option.none(),
  apps: [],
  integrations: [],
  name: 'Vivid',
})
const damiContext = VividContext.make({
  memory: remembers('Dami’s facts'),
  skills: [],
  timezone: 'Europe/Paris',
  asOf: Option.none(),
  apps: [],
  integrations: [],
  name: 'Juno',
})
const updatedContext = VividContext.make({
  memory: remembers('Updated facts'),
  skills: [],
  timezone: 'UTC',
  asOf: Option.none(),
  apps: [],
  integrations: [],
  name: 'Vivid',
})

describe('response context snapshots', () => {
  it.effect(
    'finishing one Person preserves another Person’s frozen context in a shared Thread',
    () =>
      Effect.sync(() => {
        const snapshots = contextSnapshots()
        snapshots.prepare(ada, adaContext)
        snapshots.prepare(dami, damiContext)
        snapshots.freeze(ada)
        snapshots.freeze(dami)
        snapshots.prepare(dami, updatedContext)
        snapshots.finish(ada)

        expect(snapshots.read(ada)).toEqual(Option.none())
        expect(snapshots.read(dami)).toEqual(Option.some(damiContext))
        snapshots.freeze(dami)
        expect(snapshots.read(dami)).toEqual(Option.some(updatedContext))
        snapshots.finish(dami)
        expect(snapshots.read(dami)).toEqual(Option.none())
      }),
  )

  it.effect('starting or finishing one Person preserves the other Person’s prepared context', () =>
    Effect.sync(() => {
      const snapshots = contextSnapshots()
      snapshots.prepare(ada, adaContext)
      snapshots.freeze(ada)
      snapshots.prepare(dami, damiContext)
      expect(snapshots.read(dami)).toEqual(Option.some(damiContext))
      snapshots.finish(ada)
      expect(snapshots.read(dami)).toEqual(Option.some(damiContext))
      snapshots.freeze(dami)
      snapshots.prepare(dami, updatedContext)
      expect(snapshots.read(dami)).toEqual(Option.some(damiContext))
    }),
  )

  it.effect('keeps the same Person’s contexts isolated between Threads', () =>
    Effect.sync(() => {
      const snapshots = contextSnapshots()
      const privateThread = { threadId: ThreadId.make('private'), personId: ada.personId }
      snapshots.prepare(ada, adaContext)
      snapshots.prepare(privateThread, updatedContext)
      snapshots.freeze(ada)
      snapshots.freeze(privateThread)
      snapshots.finish(ada)
      expect(snapshots.read(ada)).toEqual(Option.none())
      expect(snapshots.read(privateThread)).toEqual(Option.some(updatedContext))
    }),
  )

  it.effect('freezes absence so a late preload cannot change instructions during a response', () =>
    Effect.sync(() => {
      const snapshots = contextSnapshots()
      snapshots.prepare(dami, damiContext)
      snapshots.freeze(ada)
      snapshots.prepare(ada, adaContext)
      expect(snapshots.read(ada)).toEqual(Option.none())
      expect(snapshots.read(dami)).toEqual(Option.some(damiContext))
      snapshots.finish(ada)
      snapshots.prepare(ada, updatedContext)
      expect(snapshots.read(ada)).toEqual(Option.some(updatedContext))
    }),
  )
})
