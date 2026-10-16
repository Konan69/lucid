import { Effect, Option, Stream } from 'effect'
import {
  MachineAuthenticationFailed,
  MachineExecutionUnknown,
  MachineFileRefused,
  MachineInputInvalid,
  MachinePortClosed,
  MachineResponseInvalid,
  MachineUnreachable,
  type MachineFailure,
  type MachineKey,
  type MachineOperations,
} from '../machine.ts'
import { links } from '../ssh/links.ts'
import {
  LinkFileRefused,
  LinkHostMismatch,
  LinkKeyRefused,
  LinkPortClosed,
  LinkRunLost,
  connectionIdentity,
  LinkUnreachable,
  type Link,
  type LinkFailure,
} from '../ssh/link.ts'
import type { ProviderId } from './protocol.ts'
import type { Transport } from './transport.ts'

/**
 * "host:port", as Boat names the way in to a machine that has only an IPv6 address (seen 5 October
 * 2026: one machine had its own IPv4 on one wake and none on the next, and the hosted server has
 * no IPv6 route). A host written in brackets is taken out of them.
 */
const endpoint = (value: string) => {
  const cut = value.lastIndexOf(':')
  const host = value.slice(0, Math.max(cut, 0)).replace(/^\[|\]$/g, '')
  const port = Number(value.slice(cut + 1))
  // A reply that names no host or no usable port did not say where the machine is.
  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535)
    return Effect.fail(new MachineResponseInvalid({ operation: 'ssh-endpoint' }))
  return Effect.succeed({ host, port })
}

/**
 * What an SSH failure says at the machine boundary. A host that presents another key is some other
 * machine at an address this one had: the provider's answer did not describe what was reached,
 * which is an invalid response, never a machine to use. A lost or refused connection is an outage
 * of the path to the machine and says nothing about the machine.
 */
export const linkFailure = (failure: LinkFailure | LinkFileRefused): MachineFailure => {
  if (failure instanceof LinkFileRefused) return new MachineFileRefused({ reason: failure.reason })
  if (failure instanceof LinkHostMismatch)
    return new MachineResponseInvalid({ operation: 'ssh-host-key' })
  if (failure instanceof LinkKeyRefused) return new MachineAuthenticationFailed()
  return new MachineUnreachable()
}
const isLinkFailure = (
  failure: MachineFailure | LinkFailure | LinkFileRefused | LinkRunLost,
): failure is LinkFailure | LinkFileRefused =>
  failure instanceof LinkUnreachable ||
  failure instanceof LinkHostMismatch ||
  failure instanceof LinkKeyRefused ||
  failure instanceof LinkFileRefused

/**
 * The SSH connections to Boat machines: where each machine is, asked of Boat before every new
 * connection, and the machine boundary's words for what goes wrong on one.
 */
/** Where OpenSSH on a Boat machine reads the keys it lets in, under the user's home. */
const AUTHORIZED_KEYS = '.ssh/authorized_keys'

export const machineLinks = (api: Transport) => {
  const connections = links<MachineKey>(AUTHORIZED_KEYS)
  /**
   * Makes this opening's key pair, has Boat let its public half in on this one machine, and reads
   * where the machine is now. Boat gives a machine its
   * own IPv4 on one wake and only IPv6 on another, and then names an IPv4 endpoint; the endpoint
   * wins when it is set, because the hosted server has no IPv6 route.
   */
  const locate = Effect.fn('Machine.boat.locate')(function* (id: ProviderId) {
    const identity = yield* connectionIdentity
    const reply = yield* api.authorize(id, identity.publicKey)
    const place = yield* Option.fromNullishOr(reply.sshEndpoint).pipe(
      Option.filter((value) => value !== ''),
      Option.match({
        onNone: () => Effect.succeed({ host: reply.machineIp, port: 22 }),
        onSome: endpoint,
      }),
    )
    return { ...place, user: reply.sshUser, hostKey: reply.hostKey, identity }
  })
  /**
   * One call on the machine's connection. `accepted` answers the running machine that has
   * accepted this binding, and is asked only when a connection has to be opened. A call that
   * finds its connection gone closes that connection, so the next call dials afresh with a new
   * address; it closes no other, because by then another call may have opened a new one. This
   * call is not repeated, because a command may have run.
   */
  const over =
    (accepted: (key: MachineKey) => Effect.Effect<{ readonly id: ProviderId }, MachineFailure>) =>
    <A>(
      key: MachineKey,
      call: (link: Link) => Effect.Effect<A, LinkFailure | LinkFileRefused | LinkRunLost>,
    ): Effect.Effect<A, MachineFailure> =>
      connections
        .get(key, accepted(key).pipe(Effect.flatMap((identity) => locate(identity.id))))
        .pipe(
          Effect.flatMap((link) =>
            call(link).pipe(
              Effect.tapError((failure) =>
                failure instanceof LinkUnreachable || failure instanceof LinkRunLost
                  ? connections.discard(key, link)
                  : Effect.void,
              ),
            ),
          ),
          Effect.mapError((failure) => {
            // The command started and its end was not heard: uncertain, never run again.
            if (failure instanceof LinkRunLost) return new MachineExecutionUnknown({ key })
            return isLinkFailure(failure) ? linkFailure(failure) : failure
          }),
        )
  /** The machine boundary's `run`, `read` and `put`, over the machine's connection. */
  const operations = (
    accepted: (key: MachineKey) => Effect.Effect<{ readonly id: ProviderId }, MachineFailure>,
  ): Pick<MachineOperations, 'run' | 'converse' | 'tunnel' | 'read' | 'put'> => {
    const overLink = over(accepted)
    /** The machine's connection, taken once for something that outlives the call that asked. */
    const taken = (key: MachineKey) =>
      connections
        .get(key, accepted(key).pipe(Effect.flatMap((identity) => locate(identity.id))))
        .pipe(
          Effect.mapError((failure) => (isLinkFailure(failure) ? linkFailure(failure) : failure)),
        )
    return {
      run: Effect.fn('Machine.boat.run')(function* (input) {
        if (
          !Number.isInteger(input.timeoutSeconds) ||
          input.timeoutSeconds < 1 ||
          input.command.length < 1
        )
          return yield* new MachineInputInvalid()
        return yield* overLink(input.key, (link) =>
          link.run({
            command: input.command,
            directory: input.directory,
            timeoutSeconds: input.timeoutSeconds,
          }),
        )
      }),
      /**
       * The conversation lives longer than this call, so the connection is taken once and what
       * goes wrong later is put in the machine boundary's words where it happens: a connection
       * that went is closed, as in `over`, and a command whose end was not heard is uncertain.
       */
      converse: Effect.fn('Machine.boat.converse')(function* (input) {
        if (
          !Number.isInteger(input.timeoutSeconds) ||
          input.timeoutSeconds < 1 ||
          input.command.length < 1
        )
          return yield* new MachineInputInvalid()
        const link = yield* taken(input.key)
        const lost = <A>(effect: Effect.Effect<A, LinkRunLost>) =>
          effect.pipe(
            Effect.tapError(() => connections.discard(input.key, link)),
            Effect.mapError((): MachineFailure => new MachineExecutionUnknown({ key: input.key })),
          )
        const spoken = yield* link
          .converse({
            command: input.command,
            directory: input.directory,
            timeoutSeconds: input.timeoutSeconds,
          })
          .pipe(
            Effect.tapError(() => connections.discard(input.key, link)),
            Effect.mapError(linkFailure),
          )
        return {
          output: spoken.output.pipe(
            Stream.mapError((): MachineFailure => new MachineExecutionUnknown({ key: input.key })),
          ),
          say: (text) => lost(spoken.say(text)),
          ended: lost(spoken.ended),
        }
      }),
      /**
       * The channel lives longer than this call, as a conversation does, so the connection is
       * taken once. A connection that went while the channel was being opened is closed, as in
       * `over`; a port nothing listens on leaves the connection as it is.
       */
      tunnel: Effect.fn('Machine.boat.tunnel')(function* (input) {
        const link = yield* taken(input.key)
        return yield* link.tunnel(input.port).pipe(
          Effect.tapError((failure) =>
            failure instanceof LinkUnreachable ? connections.discard(input.key, link) : Effect.void,
          ),
          Effect.mapError((failure) =>
            failure instanceof LinkPortClosed
              ? new MachinePortClosed({ port: input.port })
              : linkFailure(failure),
          ),
        )
      }),
      read: Effect.fn('Machine.boat.read')((input) =>
        overLink(input.key, (link) => link.read(input.path)),
      ),
      put: Effect.fn('Machine.boat.put')((input) =>
        overLink(input.key, (link) => link.put(input.path, input.content)),
      ),
    }
  }
  return { forget: connections.forget, close: connections.close, operations }
}
