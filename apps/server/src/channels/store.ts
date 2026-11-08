import * as NodeCrypto from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
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
import { personTable } from '../auth/tables.ts'
import { Database, decodeStored, returned } from '../database/client.ts'
import { loadDiscordPeople } from '../connections/discord.ts'
import { changed, Changes } from '../live/changes.ts'
import { normalizeChannelPhone } from './address.ts'
import { StoredLink, standingOf } from './model.ts'
import { ChannelEnrolmentId, ChannelProvider } from './provider.ts'
import { channelCodes, channelLinks } from './tables.ts'

/** Provider identity grants only the linked Person's private workspace, never their selected Company. */
export const channelActor = Effect.fn('Channels.actor')(function* (personId: PersonId) {
  const found = yield* findPerson(personId)
  if (Option.isNone(found)) return yield* new NotFound({ message: 'Person not found' })
  return {
    person: found.value,
    workspace: Workspace.cases.Personal.make({}),
    by: 'person',
    threadId: Option.none(),
    helper: Option.none(),
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
  readonly discordPeople: ReadonlySet<string>
  readonly gate: Semaphore.Semaphore
  readonly announce: (actor: Actor) => Effect.Effect<void>
}

/** Reissuing a code preserves an existing link and replaces only an unredeemed code. */
const awaitingLink = ({
  database,
  announce,
  byPerson,
}: Pick<LinkAuthority, 'database' | 'announce' | 'byPerson'>) =>
  Effect.fn('Channels.awaiting')(function* (
    actor: Actor,
    channel: Channel,
    textTo: StoredLink['textTo'],
  ) {
    const prior = yield* byPerson(actor.person.id, channel)
    if (Option.isSome(prior))
      return ChannelLink.make({ channel, standing: standingOf(prior.value) })
    const code = String(NodeCrypto.randomInt(100000, 1000000))
    const expiresAt = (yield* Clock.currentTimeMillis) + 10 * 60 * 1000
    yield* database.run(
      database
        .insert(channelCodes)
        .values({ personId: actor.person.id, channel, code, expiresAt })
        .onConflictDoUpdate({
          target: [channelCodes.personId, channelCodes.channel],
          set: { code, expiresAt },
        }),
    )
    yield* announce(actor)
    return ChannelLink.make({
      channel,
      standing: ChannelStanding.cases.Awaiting.make({ textTo, code, expiresAt }),
    })
  })

/** One serialized connect operation owns enrolment and durable routing replacement. */
const connectLink = ({
  database,
  provider,
  gate,
  discordPeople,
  announce,
  byPerson,
  byAddress,
}: LinkAuthority) => {
  const awaitConnect = awaitingLink({ database, announce, byPerson })
  /** Enrol before publishing Connected; repeat requests reuse the existing provider receipt. */
  return Effect.fn('Channels.connect')(
    function* (actor: Actor, channel: Channel, value?: string) {
      if (
        channel === 'Discord' &&
        (!provider.channels.includes(channel) ||
          !discordPeople.has(actor.person.email.toLowerCase()))
      )
        return yield* new ChannelUnavailable({ channel })
      const textTo = provider.codeAddress(channel)
      if (Option.isSome(textTo)) {
        return yield* awaitConnect(actor, channel, textTo.value)
      }
      if (value === undefined) return yield* new ChannelAddressInvalid({ channel })
      const address = yield* normalizeChannelPhone({ channel, value }).pipe(
        Effect.mapError(() => new ChannelAddressInvalid({ channel })),
      )
      if (!provider.channels.includes(channel)) return yield* new ChannelUnavailable({ channel })
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

/** Consuming the code and publishing ownership are atomic. A conflicting address rolls back the consumed code. */
const redeemLink = ({
  database,
  provider,
  gate,
  discordPeople,
  announce,
}: Pick<LinkAuthority, 'database' | 'provider' | 'gate' | 'discordPeople' | 'announce'>) => {
  return Effect.fn('Channels.redeem')(
    function* (channel: Channel, sender: StoredLink['address'], text: string) {
      const textTo = provider.codeAddress(channel)
      if (Option.isNone(textTo)) return false
      const now = yield* Clock.currentTimeMillis
      const personId = yield* database
        .transaction((tx) =>
          Effect.gen(function* () {
            const consumed = yield* tx
              .delete(channelCodes)
              .where(
                and(
                  eq(channelCodes.channel, channel),
                  eq(channelCodes.code, text.trim()),
                  gt(channelCodes.expiresAt, now),
                ),
              )
              .returning()
            const code = consumed[0]
            if (code === undefined) return Option.none<PersonId>()
            if (channel === 'Discord') {
              const people = yield* tx
                .select({ email: personTable.email })
                .from(personTable)
                .where(eq(personTable.id, code.personId))
              const person = people[0]
              if (person === undefined || !discordPeople.has(person.email.toLowerCase()))
                return Option.none<PersonId>()
            }
            const link = {
              address: sender,
              textTo: textTo.value,
              enrolmentId: ChannelEnrolmentId.make(sender.slice('discord:'.length)),
              since: now,
              threadId: null,
            }
            yield* tx
              .insert(channelLinks)
              .values({ personId: code.personId, channel, ...link })
              .onConflictDoUpdate({
                target: [channelLinks.personId, channelLinks.channel],
                set: link,
              })
            return Option.some(code.personId)
          }),
        )
        .pipe(
          Effect.catchTag('DatabaseConstraintViolation', () =>
            Effect.fail(new ChannelAddressTaken({ channel })),
          ),
        )
      if (Option.isNone(personId)) return false
      const actor = yield* channelActor(personId.value).pipe(
        Effect.provideService(Database, database),
      )
      yield* announce(actor)
      return true
    },
    (effect) => gate.withPermit(effect),
  )
}

/** An enrolment channel's receipt is kept until the provider agrees, so a failed unenrol retries. */
const unenrolLink = ({
  database,
  provider,
  announce,
  byPerson,
}: Pick<LinkAuthority, 'database' | 'provider' | 'announce' | 'byPerson'>) =>
  Effect.fn('Channels.unenrol')(function* (actor: Actor, channel: Channel) {
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
  })

/** Linking owns personal persistence and provider enrolment; handlers contain no business decisions. */
const makeChannels = Effect.fn('Channels.makeStore')(function* (
  discordPeople: ReadonlySet<string>,
) {
  const database = yield* Database
  const provider = yield* ChannelProvider
  const changes = yield* Changes
  const gate = yield* Semaphore.make(1)
  const announce = (actor: Actor) => changed(actor).pipe(Effect.provideService(Changes, changes))

  const { byPerson, byAddress } = linkQueries(database)
  /** Listing does no network I/O; a channel Vivid does not text on yet stands Unavailable. */
  const list = Effect.fn('Channels.list')(function* (actor: Actor) {
    return yield* Effect.forEach(
      Channel.literals,
      Effect.fn('Channels.standing')(function* (channel) {
        if (
          !provider.channels.includes(channel) ||
          (channel === 'Discord' && !discordPeople.has(actor.person.email.toLowerCase()))
        )
          return ChannelLink.make({ channel, standing: ChannelStanding.cases.Unavailable.make({}) })
        const found = yield* byPerson(actor.person.id, channel)
        if (Option.isNone(found)) {
          const textTo = provider.codeAddress(channel)
          const now = yield* Clock.currentTimeMillis
          const pending = yield* database.run(
            database
              .select()
              .from(channelCodes)
              .where(
                and(
                  eq(channelCodes.personId, actor.person.id),
                  eq(channelCodes.channel, channel),
                  gt(channelCodes.expiresAt, now),
                ),
              ),
          )
          const code = pending[0]
          if (code !== undefined && Option.isSome(textTo))
            return ChannelLink.make({
              channel,
              standing: ChannelStanding.cases.Awaiting.make({
                textTo: textTo.value,
                code: code.code,
                expiresAt: code.expiresAt,
              }),
            })
        }
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

  const connect = connectLink({
    database,
    provider,
    gate,
    discordPeople,
    announce,
    byPerson,
    byAddress,
  })

  const unenrol = unenrolLink({ database, provider, announce, byPerson })

  /**
   * A code channel (Discord) deletes codes before links in one transaction, so a concurrent
   * redemption cannot outlive disconnect. An enrolment channel (iMessage) unenrols first and keeps
   * its receipt until the provider agrees, so a failed unenrol can be retried.
   */
  const disconnect = Effect.fn('Channels.disconnect')(
    function* (actor: Actor, channel: Channel) {
      if (!provider.channels.includes(channel)) return yield* new ChannelUnavailable({ channel })
      if (Option.isNone(provider.codeAddress(channel))) return yield* unenrol(actor, channel)
      const deleted = yield* database.transaction((tx) =>
        tx
          .delete(channelCodes)
          .where(and(eq(channelCodes.personId, actor.person.id), eq(channelCodes.channel, channel)))
          .pipe(
            Effect.andThen(
              tx
                .delete(channelLinks)
                .where(
                  and(
                    eq(channelLinks.personId, actor.person.id),
                    eq(channelLinks.channel, channel),
                  ),
                )
                .returning(),
            ),
          ),
      )
      if (deleted.length > 0) yield* announce(actor)
      return ChannelLink.make({ channel, standing: ChannelStanding.cases.NotConnected.make({}) })
    },
    (effect) => gate.withPermit(effect),
  )

  const redeem = redeemLink({ database, provider, gate, discordPeople, announce })

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
  return { list, connect, disconnect, redeem, byPerson, byAddress, attach }
})

export class ChannelStore extends Context.Service<
  ChannelStore,
  Effect.Success<ReturnType<typeof makeChannels>>
>()('vivid/ChannelStore') {}
export const channelStoreLayer = Layer.effect(
  ChannelStore,
  loadDiscordPeople.pipe(Effect.flatMap(makeChannels)),
)
