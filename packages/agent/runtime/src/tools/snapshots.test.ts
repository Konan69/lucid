import { describe, expect, it } from '@effect/vitest'
import { PersonId, SkillId, ThreadId } from '@vivid/contracts'
import { Effect, Option } from 'effect'
import { ContextSkill, contextSnapshots, VividContext } from './snapshots.ts'
import { builtinNames } from '../../../skills/src/manifest.ts'

const ada = { threadId: ThreadId.make('shared'), personId: PersonId.make('ada') }
const dami = { threadId: ada.threadId, personId: PersonId.make('dami') }
const adaContext = VividContext.make({ brief: 'Ada’s facts', skills: [], timezone: 'Africa/Lagos' })
const damiContext = VividContext.make({
  brief: 'Dami’s facts',
  skills: [],
  timezone: 'Europe/Paris',
})
const updatedContext = VividContext.make({ brief: 'Updated facts', skills: [], timezone: 'UTC' })

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

  it.effect(
    'freezes each Person’s native mount selection without adding private names to the catalogue',
    () =>
      Effect.sync(() => {
        const snapshots = contextSnapshots()
        const research = ContextSkill.make({
          id: SkillId.make('builtin:deep-research'),
          name: 'Deep research',
          useWhen: 'When sources are needed',
          createdAt: 0,
        })
        const privateSkill = ContextSkill.make({
          ...research,
          id: SkillId.make('MARK-private-skill'),
          name: 'Private due diligence',
        })
        snapshots.prepare(ada, VividContext.make({ ...adaContext, skills: [privateSkill] }))
        snapshots.prepare(dami, VividContext.make({ ...damiContext, skills: [research] }))
        snapshots.freeze(ada)
        snapshots.prepare(ada, VividContext.make({ ...adaContext, skills: [research] }))
        const adaNames = Option.map(snapshots.read(ada), (context) => builtinNames(context.skills))
        const damiNames = Option.map(snapshots.read(dami), (context) =>
          builtinNames(context.skills),
        )
        expect(adaNames).toEqual(Option.some([]))
        expect(damiNames).toEqual(Option.some(['deep-research']))
        expect(JSON.stringify([adaNames, damiNames])).not.toContain(privateSkill.name)
        snapshots.finish(ada)
        expect(snapshots.read(dami)).toEqual(
          Option.some(VividContext.make({ ...damiContext, skills: [research] })),
        )
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
