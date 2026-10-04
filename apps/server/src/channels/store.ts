import { and, eq } from 'drizzle-orm'
import {
  Channel,
  ChannelUnavailable,
  ChannelAddressInvalid,
  ChannelAddressTaken,
  ChannelLink,
  ChannelStanding,
  NotFound,
  Workspace,
  type PersonId,
  type ThreadId,
} from '@vivid/contracts'
import { Clock, Context, Effect, Layer, Option, Semaphore } from 'effect'
import { findPerson, type Actor } from '../auth/access.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { changed, Changes } from '../live/changes.ts'
import { normalizeChannelPhone } from './address.ts'
import { StoredLink, standingOf } from './model.ts'
import { ChannelProvider } from './provider.ts'
import { channelLinks } from './tables.ts'

/** Provider identity grants only the linked Person's private workspace, never their selected Company. */
export const channelActor = Effect.fn('Channels.actor')(function* (personId: PersonId) {
  const found = yield* findPerson(personId)
  if (Option.isNone(found)) return yield* new NotFound({ message: 'Person not found' })
  return {
    person: found.value,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
  } satisfies Actor
})

const decodeLink = decodeStored(StoredLink, 'channel link')
/** Personal and infrastructure reads share one row decoder and exact identity predicates. */
const linkQueries = (database: Database['Service']) => {
  /** Person scoping never uses the selected Company workspace: these links are always personal. */
  const byPerson = Effect.fn('Channels.byPerson')(function* (personId: PersonId, channel: Channel) {
    const rows = yield* database.run(
      database
        .select()
        .from(channelLinks)
        .where(and(eq(channelLinks.personId, personId), eq(channelLinks.channel, channel))),
    )
    return rows[0] === undefined
      ? Option.none<StoredLink>()
      : Option.some(yield* decodeLink(rows[0]))
  })

  /** This infrastructure lookup resolves ownership only after provider identity has been decoded. */
  const byAddress = Effect.fn('Channels.byAddress')(function* (
    channel: Channel,
    address: StoredLink['address'],
  ) {
    const rows = yield* database.run(
      database
        .select()
        .from(channelLinks)
        .where(and(eq(channelLinks.channel, channel), eq(channelLinks.address, address))),
    )
    return rows[0] === undefined
      ? Option.none<StoredLink>()
      : Option.some(yield* decodeLink(rows[0]))
  })

  return { byPerson, byAddress }
}

interface LinkAuthority extends ReturnType<typeof linkQueries> {
  readonly database: Database['Service']
  readonly provider: ChannelProvider['Service']
  readonly gate: Semaphore.Semaphore
  readonly announce: (actor: Actor) => Effect.Effect<void>
}

/** One serialized connect operation owns enrolment and durable routing replacement. */
const connectLink = ({
  database,
  provider,
  gate,
  announce,
  byPerson,
  byAddress,
}: LinkAuthority) => {
  /** Enrol before publishing Connected; repeat requests reuse the existing provider receipt. */
  return Effect.fn('Channels.connect')(
    function* (actor: Actor, channel: Channel, value: string) {
      const address = yield* normalizeChannelPhone({ channel, value }).pipe(
        Effect.mapError(() => new ChannelAddressInvalid({ channel })),
      )
      if (!provider.available(channel)) return yield* new ChannelUnavailable({ channel })
      const taken = yield* byAddress(channel, address)
      if (Option.isSome(taken) && taken.value.personId !== actor.person.id)
        return yield* new ChannelAddressTaken({ channel })
      const prior = yield* byPerson(actor.person.id, channel)
      if (Option.isSome(prior) && prior.value.address === address)
        return ChannelLink.make({ channel, standing: standingOf(prior.value) })
      const enrolled = yield* provider.enrol(channel, address)
      const since = yield* Clock.currentTimeMillis
      const saved = yield* database
        .run(
          database
            .insert(channelLinks)
            .values({
              personId: actor.person.id,
              channel,
              address,
              textTo: enrolled.textTo,
              enrolmentId: enrolled.id,
              since,
              threadId: null,
            })
            .onConflictDoUpdate({
              target: [channelLinks.personId, channelLinks.channel],
              set: {
                address,
                textTo: enrolled.textTo,
                enrolmentId: enrolled.id,
                since,
                threadId: null,
              },
            })
            .returning(),
        )
        .pipe(
          Effect.catchTag('DatabaseConstraintViolation', () =>
            Effect.fail(new ChannelAddressTaken({ channel })),
          ),
        )
      const link = yield* decodeLink(yield* returned(saved, 'channel link'))
      yield* announce(actor)
      // Publish the durable replacement first: a failed upsert must leave the old number enrolled.
      if (Option.isSome(prior)) yield* provider.unenrol(channel, prior.value.enrolmentId)
      return ChannelLink.make({ channel, standing: standingOf(link) })
    },
    (effect) => gate.withPermit(effect),
  )
}

/** Linking owns personal persistence and provider enrolment; handlers contain no business decisions. */
const makeChannels = Effect.fn('Channels.makeStore')(function* () {
  const database = yield* Database
  const provider = yield* ChannelProvider
  const changes = yield* Changes
  const gate = yield* Semaphore.make(1)
  const announce = (actor: Actor) => changed(actor).pipe(Effect.provideService(Changes, changes))

  const { byPerson, byAddress } = linkQueries(database)
  /** Listing does no network I/O; an absent provider stays unavailable even if old rows remain. */
  const list = Effect.fn('Channels.list')(function* (actor: Actor) {
    return yield* Effect.forEach(
      Channel.literals,
      Effect.fn('Channels.standing')(function* (channel) {
        if (!provider.available(channel))
          return ChannelLink.make({ channel, standing: ChannelStanding.cases.Unavailable.make({}) })
        const found = yield* byPerson(actor.person.id, channel)
        return ChannelLink.make({
          channel,
          standing: Option.match(found, {
            onNone: () => ChannelStanding.cases.NotConnected.make({}),
            onSome: standingOf,
          }),
        })
      }),
    )
  })

  const connect = connectLink({ database, provider, gate, announce, byPerson, byAddress })

  /** Remove the provider allowlist before releasing ownership, so another Person cannot inherit a live link. */
  const disconnect = Effect.fn('Channels.disconnect')(
    function* (actor: Actor, channel: Channel) {
      if (!provider.available(channel)) return yield* new ChannelUnavailable({ channel })
      const prior = yield* byPerson(actor.person.id, channel)
      if (Option.isSome(prior)) {
        yield* provider.unenrol(channel, prior.value.enrolmentId)
        yield* database.run(
          database
            .delete(channelLinks)
            .where(
              and(eq(channelLinks.personId, actor.person.id), eq(channelLinks.channel, channel)),
            ),
        )
        yield* announce(actor)
      }
      return ChannelLink.make({ channel, standing: ChannelStanding.cases.NotConnected.make({}) })
    },
    (effect) => gate.withPermit(effect),
  )

  /** Remember only a still-current connected link, so a disconnect cannot attach a stale Thread. */
  const attach = Effect.fn('Channels.attachThread')(function* (
    actor: Actor,
    link: StoredLink,
    threadId: ThreadId,
  ) {
    const rows = yield* database.run(
      database
        .update(channelLinks)
        .set({ threadId })
        .where(
          and(
            eq(channelLinks.personId, link.personId),
            eq(channelLinks.channel, link.channel),
            eq(channelLinks.address, link.address),
            eq(channelLinks.since, link.since),
          ),
        )
        .returning(),
    )
    if (rows.length > 0) yield* announce(actor)
    return rows.length > 0
  })
  return { list, connect, disconnect, byPerson, byAddress, attach }
})

export class ChannelStore extends Context.Service<
  ChannelStore,
  Effect.Success<ReturnType<typeof makeChannels>>
>()('vivid/ChannelStore') {}
export const channelStoreLayer = Layer.effect(ChannelStore, makeChannels())
