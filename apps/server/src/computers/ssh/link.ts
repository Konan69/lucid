import { Buffer } from 'node:buffer'
import { Effect, Redacted, Schema, type Scope } from 'effect'
import { Client, utils, type ClientChannel, type SFTPWrapper } from 'ssh2'

/**
 * One SSH connection to one machine, and the three things a caller does over it: run a command,
 * read a file, put a file. It knows SSH and nothing else: no provider, no Person, no model
 * runtime. The provider adapter (`boat.ts`) decides which machine and when; whoever calls the
 * machine boundary decides why.
 *
 * Library: `ssh2` 1.17.0 (MIT), read at `lib/client.js` (`connect`, `exec`, `sftp`, `hostVerifier`)
 * and `lib/protocol/SFTP.js` (`readFile`, `writeFile`, `mkdir`, `stat`). It is a callback API, so
 * every call below is one `Effect.callback` around exactly one library call.
 */

/** The machine could not be reached over SSH, or the connection went while it was in use. Nothing
 * is learned about the machine. */
export class LinkUnreachable extends Schema.TaggedError<LinkUnreachable>()(
  'LinkUnreachable',
  {},
  { title: 'LinkUnreachable' },
) {}

/** The host that answered did not present the key the provider reported for this machine: it is
 * some other machine, and nothing was sent to it. */
export class LinkHostMismatch extends Schema.TaggedError<LinkHostMismatch>()(
  'LinkHostMismatch',
  {},
  { title: 'LinkHostMismatch' },
) {}

/** The machine refused the installation's key. */
export class LinkKeyRefused extends Schema.TaggedError<LinkKeyRefused>()(
  'LinkKeyRefused',
  {},
  { title: 'LinkKeyRefused' },
) {}

/** Why the machine's file system refused a read or a write, in the words a caller can act on. */
export const FileRefusal = Schema.Literals(['missing', 'denied', 'directory', 'large', 'other'])
export type FileRefusal = typeof FileRefusal.Type

/** A file operation the machine answered with a refusal. The connection is fine. */
export class LinkFileRefused extends Schema.TaggedError<LinkFileRefused>()(
  'LinkFileRefused',
  { reason: FileRefusal },
  { title: 'LinkFileRefused' },
) {}

export type LinkFailure = LinkUnreachable | LinkHostMismatch | LinkKeyRefused

/** How a command ended. `timedOut` is this side's deadline; the exit code is then absent. */
export interface LinkRun {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** Either stream passed `OUTPUT_BYTES`, and only its end was kept. */
  readonly truncated: boolean
}

export interface Link {
  /** Runs `command` with bash as a login shell, in `directory`. */
  readonly run: (input: {
    readonly command: string
    readonly directory: string
    readonly timeoutSeconds: number
  }) => Effect.Effect<LinkRun, LinkUnreachable>
  readonly read: (path: string) => Effect.Effect<Uint8Array, LinkUnreachable | LinkFileRefused>
  /** Creates the missing directories above `path`, then replaces the file. */
  readonly put: (
    path: string,
    content: Uint8Array,
  ) => Effect.Effect<void, LinkUnreachable | LinkFileRefused>
}

/** The end of each output stream that is kept. A command may print without limit; what reads the
 * result shows its last lines, so the end is the part worth keeping. */
export const OUTPUT_BYTES = 262_144
/** The largest file read or put in one call. Larger files are a command's work (`head`, `split`). */
export const FILE_BYTES = 10_485_760

/** `value` as one word of a POSIX shell command. */
export const shellWord = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * The installation's key pair from its private key (OpenSSH or PEM text). The public half is
 * derived, never configured apart: two settings could disagree.
 */
export const identity = Effect.fn('Link.identity')(function* (key: Redacted.Redacted) {
  const parsed = utils.parseKey(Redacted.value(key))
  // ssh2 answers an Error for text that is not a key, and an array for a file of several keys.
  if (parsed instanceof Error || Array.isArray(parsed)) return yield* Effect.fail(new LinkKeyRefused())
  if (!parsed.isPrivateKey()) return yield* Effect.fail(new LinkKeyRefused())
  return {
    privateKey: key,
    /** One `authorized_keys` line: the type and the key, with a name that says whose it is. */
    publicKey: `${parsed.type} ${parsed.getPublicSSH().toString('base64')} vivid`,
  }
})
export type Identity = Effect.Success<ReturnType<typeof identity>>

/** Keeps the last `OUTPUT_BYTES` of a stream as it arrives, so a flood cannot hold memory. */
const tail = () => {
  let kept: ReadonlyArray<Buffer> = []
  let size = 0
  let cut = false
  return {
    add: (piece: Buffer) => {
      kept = [...kept, piece]
      size += piece.length
      // Drop whole pieces from the front while what stays is still a full tail.
      for (;;) {
        const [first, ...rest] = kept
        if (first === undefined || rest.length === 0 || size - first.length < OUTPUT_BYTES) return
        kept = rest
        size -= first.length
        cut = true
      }
    },
    text: () => {
      const all = Buffer.concat(kept)
      if (all.length <= OUTPUT_BYTES) return { text: all.toString('utf8'), cut }
      return { text: all.subarray(all.length - OUTPUT_BYTES).toString('utf8'), cut: true }
    },
  }
}

/** SFTP status codes (draft-ietf-secsh-filexfer-02 section 7) as a caller's reasons. */
const refusal = (error: Error & { readonly code?: unknown }): FileRefusal => {
  if (error.code === 2) return 'missing'
  if (error.code === 3) return 'denied'
  return 'other'
}

/** The connection went, as opposed to the machine answering "no": ssh2 gives a status code only
 * for an SFTP answer. */
const fileFailure = (error: Error & { readonly code?: unknown }) =>
  typeof error.code === 'number'
    ? new LinkFileRefused({ reason: refusal(error) })
    : new LinkUnreachable()

const directoryOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0))

/** Every directory from the top down to `path`, as `mkdir -p` would visit them. */
const ancestors = (path: string): ReadonlyArray<string> => {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)
}

const files = (sftp: SFTPWrapper) => {
  const size = (path: string) =>
    Effect.callback<number, LinkUnreachable | LinkFileRefused>((resume) => {
      sftp.stat(path, (error, stats) => {
        if (error !== undefined && error !== null) return resume(Effect.fail(fileFailure(error)))
        if (stats.isDirectory())
          return resume(Effect.fail(new LinkFileRefused({ reason: 'directory' })))
        return resume(Effect.succeed(stats.size))
      })
    })
  const read = Effect.fn('Link.read')(function* (path: string) {
    // Asked first: a read answers the whole file, and one that is too large must not be fetched.
    if ((yield* size(path)) > FILE_BYTES)
      return yield* Effect.fail(new LinkFileRefused({ reason: 'large' }))
    return yield* Effect.callback<Uint8Array, LinkUnreachable | LinkFileRefused>((resume) => {
      sftp.readFile(path, (error, data) => {
        if (error !== undefined && error !== null) return resume(Effect.fail(fileFailure(error)))
        return resume(Effect.succeed(new Uint8Array(data)))
      })
    })
  })
  /** One level; a directory that is already there is the wanted state, and SFTP has no code that
   * says so (OpenSSH answers the general failure, 4), so the answer is not read. The write that
   * follows fails precisely if the directory is in truth missing. */
  const make = (path: string) =>
    Effect.callback<void>((resume) => {
      sftp.mkdir(path, () => resume(Effect.void))
    })
  const write = (path: string, content: Uint8Array) =>
    Effect.callback<void, LinkUnreachable | LinkFileRefused>((resume) => {
      sftp.writeFile(path, Buffer.from(content), (error) => {
        if (error !== undefined && error !== null) return resume(Effect.fail(fileFailure(error)))
        return resume(Effect.void)
      })
    })
  const put = Effect.fn('Link.put')(function* (path: string, content: Uint8Array) {
    if (content.length > FILE_BYTES)
      return yield* Effect.fail(new LinkFileRefused({ reason: 'large' }))
    // Straight first: the directory nearly always exists, and that is one round trip.
    const direct = yield* Effect.result(write(path, content))
    if (direct._tag === 'Success') return undefined
    if (!(direct.failure instanceof LinkFileRefused) || direct.failure.reason !== 'missing')
      return yield* Effect.fail(direct.failure)
    yield* Effect.forEach(ancestors(directoryOf(path)), make, { discard: true })
    return yield* write(path, content)
  })
  return { read, put }
}

/** How long after its deadline a command that ignores the polite signal is killed. */
const GRACE_SECONDS = 2

/**
 * One command on its own channel.
 *
 * Ending it is the machine's work, because closing an SSH channel does not end a command that has
 * no terminal (seen with OpenSSH 9: the command ran on). So the command runs under coreutils
 * `timeout`, which makes it a process group of its own: at the deadline `timeout` signals the
 * whole group, and kills it `GRACE_SECONDS` later. A caller that stops waiting (the model
 * cancelled, the request ended) sends that same `timeout` a TERM over the channel, which it
 * passes to the group in the same way. This side also stops waiting a little after the deadline,
 * so a machine that never answers cannot hold the caller.
 */
const runner =
  (client: Client): Link['run'] =>
  ({ command, directory, timeoutSeconds }) =>
    Effect.callback<LinkRun, LinkUnreachable>((resume) => {
      const stdout = tail()
      const stderr = tail()
      let channel: ClientChannel | undefined
      const started = Date.now()
      const finish = (code: number | null, timedOut: boolean) => {
        clearTimeout(timer)
        const out = stdout.text()
        const err = stderr.text()
        resume(
          Effect.succeed({
            stdout: out.text,
            stderr: err.text,
            exitCode: timedOut ? null : code,
            timedOut,
            truncated: out.cut || err.cut,
          }),
        )
      }
      const stop = () => {
        channel?.signal('TERM')
        channel?.close()
      }
      // A login shell, as a person at the machine has: their PATH and their profile.
      const script = `cd -- ${shellWord(directory)} || exit 1\n${command}`
      const timer = setTimeout(
        () => {
          stop()
          finish(null, true)
        },
        (timeoutSeconds + GRACE_SECONDS + 3) * 1000,
      )
      client.exec(
        `exec timeout -k ${GRACE_SECONDS} ${timeoutSeconds} bash -lc ${shellWord(script)}`,
        (error, opened) => {
          if (error !== undefined && error !== null) {
            clearTimeout(timer)
            return resume(Effect.fail(new LinkUnreachable()))
          }
          channel = opened
          opened.on('data', stdout.add)
          opened.stderr.on('data', stderr.add)
          opened.on('close', (code: number | null) => {
            // `timeout` answers 124 when it ended the command, 137 when it had to kill it. A
            // command may exit with those codes itself, so the clock decides which it was.
            const expired =
              (code === 124 || code === 137) && Date.now() - started >= timeoutSeconds * 1000
            finish(typeof code === 'number' ? code : null, expired)
          })
          return undefined
        },
      )
      return Effect.sync(() => {
        clearTimeout(timer)
        stop()
      })
    })

/** The file subsystem is opened once per connection and shared by every read and put. */
const subsystem = (client: Client) =>
  Effect.callback<SFTPWrapper, LinkUnreachable>((resume) => {
    client.sftp((error, sftp) => {
      if (error !== undefined && error !== null) return resume(Effect.fail(new LinkUnreachable()))
      return resume(Effect.succeed(sftp))
    })
  })

/** The key the host presents, compared with the one the provider reported, byte for byte.
 * `expected` is an OpenSSH public key line; its second word is the wire encoding ssh2 passes. */
const sameHost = (expected: string, presented: Buffer) => {
  const [, encoded] = expected.trim().split(/\s+/)
  return encoded !== undefined && Buffer.from(encoded, 'base64').equals(presented)
}

/**
 * Opens the connection and holds it for the scope. A machine that has just been woken refuses
 * connections for a while, so the caller retries this; nothing here waits or retries.
 */
export const openLink = Effect.fn('Link.open')(function* (input: {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly identity: Identity
  readonly hostKey: string
}): Effect.fn.Return<Link, LinkFailure, Scope.Scope> {
  const client = yield* Effect.acquireRelease(
    Effect.callback<Client, LinkFailure>((resume) => {
      const connection = new Client()
      let mismatch = false
      connection.once('ready', () => resume(Effect.succeed(connection)))
      connection.once('error', (error: Error & { readonly level?: string }) => {
        if (mismatch) return resume(Effect.fail(new LinkHostMismatch()))
        if (error.level === 'client-authentication') return resume(Effect.fail(new LinkKeyRefused()))
        return resume(Effect.fail(new LinkUnreachable()))
      })
      connection.connect({
        host: input.host,
        port: input.port,
        username: input.user,
        privateKey: Redacted.value(input.identity.privateKey),
        readyTimeout: 15_000,
        // A connection that idles through a NAT or a proxy is dropped silently; a probe every
        // fifteen seconds keeps it, and three lost ones end it so the next call dials afresh.
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostVerifier: (presented: Buffer) => {
          mismatch = !sameHost(input.hostKey, presented)
          return !mismatch
        },
      })
      return Effect.sync(() => connection.destroy())
    }),
    (connection) => Effect.sync(() => connection.end()),
  )
  const sftp = yield* subsystem(client)
  const { read, put } = files(sftp)
  return { run: runner(client), read, put }
})
