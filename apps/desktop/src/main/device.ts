import { VividRpcClient, type VividRpcClientService } from '@vivid/client-runtime'
import {
  DeviceAccess,
  Forbidden,
  NotFound,
  Unauthenticated,
  type AnswerDeviceRequest,
  type Device,
  type DeviceAnswer,
  type DeviceId,
  type DeviceName,
  type DeviceRequest,
  type InstallationId,
} from '@vivid/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Redacted from 'effect/Redacted'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import * as Socket from 'effect/unstable/socket/Socket'
import { DeviceLink } from '../shared/device.ts'
import { ServerSettings } from '../shared/settings.ts'

/** Nobody is signed in on this connection. The link rests until a session appears. */
export class LinkSignedOut extends Schema.TaggedError<LinkSignedOut>()(
  'LinkSignedOut',
  {},
  { title: 'Nobody is signed in' },
) {}
/** The server would not let this app listen as that Device. Enrolling again says why. */
export class LinkRefused extends Schema.TaggedError<LinkRefused>()(
  'LinkRefused',
  {},
  { title: 'The server refused the link' },
) {}
/** The connection failed or the server could not answer. Worth trying again later. */
export class LinkDown extends Schema.TaggedError<LinkDown>()(
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

export type LinkFailure = LinkSignedOut | LinkRefused | LinkDown

/**
 * The three Device calls the link makes, on one connection, as one signed-in session. A narrow
 * seam over the shared typed client so the link's behaviour can be tested without a socket.
 */
export interface DeviceServer {
  /** Names this installation to the server. Repeating it returns the same Device. */
  readonly enrol: Effect.Effect<Device, LinkFailure>
  /** Listens for actions. Open, it is what makes this computer `Connected`. */
  readonly watch: (device: DeviceId) => Stream.Stream<DeviceRequest, LinkFailure>
  /** Answers one action, on the connection it arrived on. */
  readonly answer: (answer: AnswerDeviceRequest) => Effect.Effect<void, LinkFailure>
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
export const deviceServer = (
  client: VividRpcClientService,
  identity: { readonly installation: InstallationId; readonly name: DeviceName },
): DeviceServer => ({
  enrol: client.EnrolDevice(identity).pipe(
    Effect.map((response) => response.device),
    Effect.mapError(linkFailure),
  ),
  watch: (device) =>
    client
      .WatchDeviceRequests({ device, installation: identity.installation })
      .pipe(Stream.mapError(linkFailure)),
  answer: (answer) => client.AnswerDeviceRequest(answer).pipe(Effect.mapError(linkFailure)),
})

/** The `Cookie` header a browser would send for these cookies; nothing when there are none. */
export function cookieHeader(
  cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): Option.Option<Redacted.Redacted> {
  if (cookies.length === 0) return Option.none()
  return Option.some(
    Redacted.make(cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')),
  )
}

/** The live endpoint of a chosen server: the same origin, on the socket scheme. */
export const liveAddress = (origin: string) => `${origin.replace(/^http/u, 'ws')}/api/live`

/**
 * Node's WebSocket, which takes the upgrade request's headers in its second argument (undici's
 * `WebSocketInit`). A browser's cannot, which is why the web app relies on the cookie jar; the
 * main process has no cookie jar on its sockets, so it says who it is in the header.
 */
const HeaderSocket = globalThis.WebSocket

/**
 * Opens the live connection as the app's own signed-in session.
 *
 * The desktop app signs in through its web renderer, and the session is Better Auth's cookie in
 * the app's Chromium session (`persist:vivid`). The main process cannot open a socket through
 * that session, so it reads the cookies the session holds for the chosen server and sends them
 * on the upgrade, with the server's own origin, exactly as the renderer's socket does. It never
 * reads the pages partition (`persist:vivid-pages`): what a Person signs in to in a page is not
 * the app's identity. The cookie is held only for the life of one connection and is never logged.
 *
 * Nothing is opened when no server is chosen or the session holds no cookie for it.
 */
export const connectDevice = Effect.fn('DesktopDevice.connect')(function* (input: {
  readonly server: () => ServerSettings
  /** The app session's cookies for one origin (`session.cookies.get({ url })`). */
  readonly cookies: (
    origin: string,
  ) => Promise<ReadonlyArray<{ readonly name: string; readonly value: string }>>
  readonly identity: { readonly installation: InstallationId; readonly name: DeviceName }
}) {
  const server = input.server()
  if (ServerSettings.guards.NoServer(server)) return Option.none<DeviceServer>()
  const { origin } = server
  const cookie = yield* Effect.tryPromise({
    try: () => input.cookies(origin),
    catch: () => new LinkDown({}),
  }).pipe(
    Effect.map(cookieHeader),
    Effect.catchTag('LinkDown', () => Effect.succeed(Option.none<Redacted.Redacted>())),
  )
  if (Option.isNone(cookie)) return Option.none<DeviceServer>()
  const headers = { cookie: Redacted.value(cookie.value), origin }
  const client = yield* Layer.build(
    VividRpcClient.layerLive({ url: liveAddress(origin), onLink: () => undefined }).pipe(
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor)(
          (address) => new HeaderSocket(address, { headers }),
        ),
      ),
    ),
  )
  return Option.some(deviceServer(Context.get(client, VividRpcClient), input.identity))
})

export interface DeviceLinkDependencies {
  /** One connection as the signed-in session, or nothing when there is no server or session. */
  readonly connect: Effect.Effect<Option.Option<DeviceServer>, never, Scope.Scope>
  /** Carries out one action. Nothing means its deadline passed and there is no one to answer. */
  readonly execute: (request: DeviceRequest) => Effect.Effect<Option.Option<DeviceAnswer>>
}

/**
 * How long to wait before trying again: a second, doubling, never more than half a minute. The
 * same shape the server uses for its own retries (`Schedule.min` of an exponential and a cap).
 */
export const reconnect = Schedule.min([
  Schedule.exponential('1 second'),
  Schedule.spaced('30 seconds'),
])

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

  /** One action: carry it out, and answer if there is still someone to answer. */
  const handle = Effect.fn('DesktopDevice.handle')(function* (
    server: DeviceServer,
    device: DeviceId,
    request: DeviceRequest,
  ) {
    const answer = yield* dependencies.execute(request)
    if (Option.isNone(answer)) return undefined
    return yield* server.answer({ device, id: request.id, answer: answer.value })
  })

  /** Listens until the server ends the link, then looks again to learn why it ended. */
  const listen = Effect.fn('DesktopDevice.listen')(function* (
    server: DeviceServer,
    device: DeviceId,
  ) {
    link = DeviceLink.cases.Linked.make({ device })
    yield* Stream.runForEach(server.watch(device), (request) => handle(server, device, request))
    // The server closes a link on revoke, on sign-out and when a newer link replaces it.
    // Enrolling again is how the app learns which; until then it is not listening.
    return yield* again(DeviceLink.cases.Waiting.make({ device }))
  })

  /** One connection, from enrolling to its end. `true` means rest until woken. */
  const pass = Effect.fn('DesktopDevice.pass')(function* () {
    const server = yield* dependencies.connect
    if (Option.isNone(server)) return yield* rest(DeviceLink.cases.SignedOut.make({}))
    const device = yield* server.value.enrol
    return yield* DeviceAccess.match<Effect.Effect<boolean, LinkRetry | LinkFailure>>(
      device.access,
      {
        Pending: () => again(DeviceLink.cases.Waiting.make({ device: device.id })),
        Revoked: () => rest(DeviceLink.cases.Revoked.make({ device: device.id })),
        Allowed: () => listen(server.value, device.id),
      },
    )
  })

  const settled = Effect.scoped(pass()).pipe(
    Effect.catchTags({
      LinkSignedOut: () => rest(DeviceLink.cases.SignedOut.make({})),
      // Refused while listening or answering: the Device changed under the link. Look again.
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
    /** Something may have changed (a sign-in, the Person's decision). Never drops a live link. */
    wake: () => {
      if (!DeviceLink.guards.Linked(link)) Queue.offerUnsafe(wakes, undefined)
    },
    /** The server or the session is different now: drop any link and start over. */
    restart: () => {
      Queue.offerUnsafe(wakes, undefined)
    },
  }
})
