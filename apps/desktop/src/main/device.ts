import { VividRpcClient, type VividRpcClientService } from '@vivid/client-runtime'
import {
  DeviceAccess,
  Forbidden,
  NotFound,
  Unauthenticated,
  type AnswerDeviceRequest,
  type Device,
  DeviceRequest,
  type DeviceAbility,
  type DeviceAnswer,
  type DeviceId,
  type DeviceName,
  type InstallationId,
  type RunId,
} from '@vivid/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as Socket from 'effect/socket/Socket'
import { DeviceLink } from '../shared/device.ts'
import { ServerSettings } from '../shared/settings.ts'

/** Nobody is signed in on this connection. The link rests until a session appears. */
class LinkSignedOut extends Schema.TaggedError<LinkSignedOut>()(
  'LinkSignedOut',
  {},
  { title: 'Nobody is signed in' },
) {}
/** The server would not let this app listen as that Device. Enrolling again says why. */
class LinkRefused extends Schema.TaggedError<LinkRefused>()(
  'LinkRefused',
  {},
  { title: 'The server refused the link' },
) {}
/** The connection failed or the server could not answer. Worth trying again later. */
class LinkDown extends Schema.TaggedError<LinkDown>()(
  'LinkDown',
  {},
  { title: 'The link is down' },
) {}
/** This pass ended in a state that time can change: try again on the schedule. */
class LinkRetry extends Schema.TaggedError<LinkRetry>()(
  'LinkRetry',
  {},
  { title: 'The link will be tried again' },
) {}

type LinkFailure = LinkSignedOut | LinkRefused | LinkDown

/** One piece of work the server sent: the `Act` case of `DeviceRequest`. */
export type DeviceAct = typeof DeviceRequest.cases.Act.Type

/**
 * The Device calls the link makes, on one connection, as one signed-in session. A narrow
 * seam over the shared typed client so the link's behaviour can be tested without a socket.
 */
export interface DeviceServer {
  /** Names this installation to the server. Repeating it returns the same Device. */
  readonly enrol: Effect.Effect<Device, LinkFailure>
  /**
   * Listens for work, saying what this app can do right now. Open, it is what makes this
   * computer `Connected`.
   */
  readonly watch: (
    device: DeviceId,
    ability: DeviceAbility,
  ) => Stream.Stream<DeviceRequest, LinkFailure>
  /** Answers one action, on the connection it arrived on. */
  readonly answer: (answer: AnswerDeviceRequest) => Effect.Effect<void, LinkFailure>
  /** Says the Person stopped Vivid on this computer with nothing in flight (`ReportDeviceStop`). */
  readonly stopped: (device: DeviceId, runId: RunId) => Effect.Effect<void, LinkFailure>
}

const signedOut = Schema.is(Unauthenticated)
const refused = Schema.is(Schema.Union([Forbidden, NotFound]))

/**
 * What a failed call means for the link. Only three things matter here: nobody is signed in,
 * the server said no to this Device, or anything else, which is treated as a connection to retry.
 */
const linkFailure = (failure: { readonly _tag: string }): LinkFailure => {
  if (signedOut(failure)) return new LinkSignedOut({})
  if (refused(failure)) return new LinkRefused({})
  return new LinkDown({})
}

/** The link's calls over the shared client (`packages/client/rpc`), for one installation. */
const deviceServer = (
  client: VividRpcClientService,
  identity: { readonly installation: InstallationId; readonly name: DeviceName },
): DeviceServer => ({
  enrol: client.EnrolDevice(identity).pipe(
    Effect.map((response) => response.device),
    Effect.mapError(linkFailure),
  ),
  watch: (device, ability) =>
    client
      .WatchDeviceRequests({ device, installation: identity.installation, ability })
      .pipe(Stream.mapError(linkFailure)),
  answer: (answer) => client.AnswerDeviceRequest(answer).pipe(Effect.mapError(linkFailure)),
  stopped: (device, runId) =>
    client
      .ReportDeviceStop({ device, installation: identity.installation, runId })
      .pipe(Effect.mapError(linkFailure)),
})

/** The live endpoint of a chosen server: the same origin, on the socket scheme. */
const liveAddress = (origin: string) => `${origin.replace(/^http/u, 'ws')}/api/live`

/**
 * Opens the live connection as the app's own signed-in session.
 *
 * The desktop app signs in through its web renderer, and the session is Better Auth's cookie in
 * the app's Chromium session (`persist:vivid`). `socket` opens a WebSocket in that same session
 * with its cookies on the upgrade (Electron's `WebSocket` with `session` and `useSessionCookies`,
 * supplied by `main.ts`), so the main process never reads, holds or logs the cookie itself. It is
 * never the pages partition (`persist:vivid-pages`): what a Person signs in to in a page is not
 * the app's identity. Whether anyone is signed in is the server's answer to enrolling, not
 * something guessed from the cookie jar.
 *
 * Nothing is opened when no server is chosen.
 */
export const connectDevice = Effect.fn('DesktopDevice.connect')(function* (input: {
  readonly server: () => ServerSettings
  /** Opens a WebSocket to this address as the app session, naming this origin. */
  readonly socket: (address: string, origin: string) => Socket.WebSocketLike
  readonly identity: { readonly installation: InstallationId; readonly name: DeviceName }
}) {
  const server = input.server()
  if (ServerSettings.guards.NoServer(server)) return Option.none<DeviceServer>()
  const { origin } = server
  const client = yield* Layer.build(
    VividRpcClient.layerLive({ url: liveAddress(origin), onLink: () => undefined }).pipe(
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor)((address) => input.socket(address, origin)),
      ),
    ),
  )
  return Option.some(deviceServer(Context.get(client, VividRpcClient), input.identity))
})

/** What a change to one of the app session's cookies means for the link. */
export type SessionChange =
  /** The session itself is different: drop any link and start over as whoever is signed in now. */
  | 'Restart'
  /** Something else changed: look again if resting, and leave a listening link alone. */
  | 'Wake'

/**
 * Decides what a cookie change means, and remembers what it has seen.
 *
 * The session is Better Auth's session token cookie, whose name ends in `session_token` whatever
 * prefix the server gives it. When that cookie is removed or its value changes, the Person signed
 * out or someone else signed in, and a link opened as the old session must not go on acting: the
 * server ends it too, but the app does not wait to be told. Chromium reports an overwrite as a
 * removal followed by the new cookie; the removal half is not a sign-out, so it is passed over
 * and the new value decides. A token rewritten with the same value is a refresh, not a change.
 */
export function sessionChanges(known: Map<string, string>) {
  return (change: {
    readonly name: string
    readonly value: string
    readonly removed: boolean
    readonly overwritten: boolean
  }): SessionChange => {
    if (!change.name.endsWith('session_token')) return 'Wake'
    if (change.removed) {
      if (change.overwritten) return 'Wake'
      known.delete(change.name)
      return 'Restart'
    }
    const same = known.get(change.name) === change.value
    known.set(change.name, change.value)
    return same ? 'Wake' : 'Restart'
  }
}

export interface DeviceLinkDependencies {
  /** One connection as the signed-in session, or nothing when no server is chosen. */
  readonly connect: Effect.Effect<Option.Option<DeviceServer>, never, Scope.Scope>
  /**
   * What this app can do, asked each time it starts listening. `apps` is true only where Vivid's
   * Computer is on this computer.
   */
  readonly ability: () => DeviceAbility
  /**
   * Carries out one piece of work. Nothing means there is no one to answer or nothing honest to
   * say: its deadline passed, or a change was sent and what came of it is not known.
   */
  readonly execute: (request: DeviceAct) => Effect.Effect<Option.Option<DeviceAnswer>>
  /** The server said this Run is over: the turn in the Person's apps ends with it. */
  readonly ended: (runId: RunId) => Effect.Effect<void>
  /** Listening ended, for any reason. Whatever Vivid held on this computer is let go. */
  readonly unlinked: Effect.Effect<void>
  /** The Runs the Person stopped with nothing in flight, to tell the server at once. */
  readonly stops: Queue.Dequeue<RunId>
}

/**
 * How long to wait before trying again: a second, doubling, never more than half a minute. The
 * same shape the server uses for its own retries (`Schedule.min` of an exponential and a cap).
 */
const reconnect = Schedule.min([Schedule.exponential('1 second'), Schedule.spaced('30 seconds')])

/**
 * Keeps this computer linked to Vivid for as long as its Person allows it.
 *
 * One pass is one connection: enrol, then do what the Person's decision says. Allowed, it listens
 * and carries out each action as it arrives, answering on the same connection, which is the only
 * one the server accepts the answer on. Waiting to be allowed, it asks again on the schedule.
 * Revoked or signed out, it stops and rests until something changes: a sign-in, a different
 * server, or the Person using the list of computers. A connection that drops is retried on the
 * same schedule, and nothing sent while it was down is asked for again; the server does not
 * replay, and an action is authority to act once.
 *
 * Work is a step in a page of the app's own browser or an action in an app on the computer; the
 * link does not tell them apart beyond handing each to `execute`. `RunEnded` is passed on so the
 * turn in the Person's apps ends with its Run, and a stop the Person made between two actions is
 * reported on the same connection.
 *
 * Consent ends action, at once. An action runs in a fiber that belongs to the listening itself:
 * when the server ends the link (revoke, sign-out, a newer link), when the connection fails, or
 * when the app restarts the link because the session changed, that fiber is interrupted, the
 * executor's release steps run, and no further input is sent. The link never waits for an action
 * to finish before noticing that it has lost the right to act.
 *
 * The model is the server's (`apps/server/src/computers/device.ts`): the app dials out, a link
 * exists only while it is held open, and enrolling never grants anything.
 */
export const deviceLink = Effect.fn('DesktopDevice.makeLink')(function* (
  dependencies: DeviceLinkDependencies,
) {
  // At most one wake is remembered: several reasons to look again are one reason.
  const wakes = yield* Queue.sliding<void>(1)
  let link: DeviceLink = DeviceLink.cases.SignedOut.make({})
  const rest = (next: DeviceLink) =>
    Effect.sync(() => {
      link = next
      return true
    })
  const again = (next: DeviceLink) =>
    Effect.sync(() => {
      link = next
    }).pipe(Effect.andThen(Effect.fail(new LinkRetry({}))))

  /**
   * One action: carry it out, and answer if there is still someone to answer. An answer the
   * server will not take (too late, or the link changed) and one that could not be sent have the
   * same consequence here, none: the listening stream is what says whether the link still stands.
   */
  const handle = Effect.fn('DesktopDevice.handle')(function* (
    server: DeviceServer,
    device: DeviceId,
    request: DeviceAct,
  ) {
    const answer = yield* dependencies.execute(request)
    if (Option.isNone(answer)) return undefined
    return yield* server.answer({ device, id: request.id, answer: answer.value }).pipe(
      Effect.catchTags({
        LinkSignedOut: () => Effect.void,
        LinkRefused: () => Effect.void,
        LinkDown: () => Effect.void,
      }),
    )
  })

  /**
   * Listens until the server ends the link, then looks again to learn why it ended. Each action
   * is forked into the scope of the listening, so the stream is read while an action runs and
   * the end of the stream, for any reason, interrupts the action in progress.
   */
  const listen = Effect.fn('DesktopDevice.listen')(function* (
    server: DeviceServer,
    device: DeviceId,
  ) {
    link = DeviceLink.cases.Linked.make({ device })
    // A stop with nothing in flight has no answer to ride on, so it is said by itself. A report
    // the server will not take changes nothing here: the Run is stopped on this computer already.
    const reporting = Stream.runForEach(Stream.fromQueue(dependencies.stops), (runId) =>
      server.stopped(device, runId).pipe(Effect.ignore),
    )
    yield* Effect.scoped(
      Effect.forkScoped(reporting).pipe(
        Effect.andThen(
          Stream.runForEach(server.watch(device, dependencies.ability()), (request) =>
            DeviceRequest.match(request, {
              Act: (act) => Effect.forkScoped(handle(server, device, act)).pipe(Effect.asVoid),
              RunEnded: ({ runId }) => dependencies.ended(runId),
            }),
          ),
        ),
      ),
      // Consent ends action for apps as for pages: the turn ends and the Computer is let go.
    ).pipe(Effect.ensuring(dependencies.unlinked))
    // The server closes a link on revoke, on sign-out and when a newer link replaces it.
    // Enrolling again is how the app learns which; until then it is not listening.
    return yield* again(DeviceLink.cases.Waiting.make({ device }))
  })

  /** One connection, from enrolling to its end. `true` means rest until woken. */
  const pass = Effect.fn('DesktopDevice.pass')(function* () {
    const server = yield* dependencies.connect
    if (Option.isNone(server)) return yield* rest(DeviceLink.cases.SignedOut.make({}))
    const device = yield* server.value.enrol
    return yield* DeviceAccess.match(device.access, {
      Pending: () => again(DeviceLink.cases.Waiting.make({ device: device.id })),
      Revoked: () => rest(DeviceLink.cases.Revoked.make({ device: device.id })),
      Allowed: () => listen(server.value, device.id),
    })
  })

  const settled = Effect.scoped(pass()).pipe(
    Effect.catchTags({
      LinkSignedOut: () => rest(DeviceLink.cases.SignedOut.make({})),
      // Refused while listening: the Device changed under the link. Look again.
      LinkRefused: () => Effect.fail(new LinkRetry({})),
      LinkDown: () => again(DeviceLink.cases.Unreachable.make({})),
    }),
    Effect.retry(reconnect),
  )

  /**
   * Runs until interrupted. A wake during a retry or a wait starts a fresh pass at once; a pass
   * that ends in a resting state waits for the next wake and does nothing in between.
   */
  const run = Effect.forever(
    Effect.gen(function* () {
      const resting = yield* Effect.raceFirst(settled, Queue.take(wakes).pipe(Effect.as(false)))
      if (resting) yield* Queue.take(wakes)
    }),
  )

  return {
    run,
    /** What this computer is to Vivid, as last heard. */
    state: () => link,
    /** Something may have changed (the Person's decision). Never drops a link that is listening. */
    wake: () => {
      if (!DeviceLink.guards.Linked(link)) Queue.offerUnsafe(wakes, undefined)
    },
    /**
     * The server or the session is different now: drop any link, interrupting an action in
     * progress, and start over.
     */
    restart: () => {
      Queue.offerUnsafe(wakes, undefined)
    },
  }
})
