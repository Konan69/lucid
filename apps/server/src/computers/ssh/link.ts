import * as NodeBuffer from 'node:buffer'
import { Effect, Option, Predicate, Redacted, Result, Schema, type Scope } from 'effect'
// ssh2 is CommonJS and Node's ESM loader finds no named exports in it (seen: the server entry
// failed to load with a named import that Vite had accepted), so the module is imported whole.
import ssh2, { type Client, type ClientChannel, type SFTPWrapper } from 'ssh2'

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

/** A command was started and the connection went before its end was heard: it may have run, may
 * still be running, and must not be run again by itself. */
export class LinkRunLost extends Schema.TaggedError<LinkRunLost>()(
  'LinkRunLost',
  {},
  { title: 'LinkRunLost' },
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
  /** Runs `command` with bash as a login shell, in `directory` (an absolute path). */
  readonly run: (input: {
    readonly command: string
    readonly directory: string
    readonly timeoutSeconds: number
  }) => Effect.Effect<LinkRun, LinkUnreachable | LinkRunLost>
  /** False once the connection has closed; whoever holds the link opens another. */
  readonly alive: () => boolean
  readonly read: (path: string) => Effect.Effect<Uint8Array, LinkUnreachable | LinkFileRefused>
  /** Creates the missing directories above `path` (an absolute path), then replaces the file. */
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
 * The comment on every key line Vivid puts on a machine, declared once: it is written on the key
 * a connection is given and it is how the lines of ended connections are found and removed
 * (`pruneKeys`). A machine's provider keeps the comment of a key it is asked to authorize (seen
 * on Boat, 5 October 2026).
 */
export const KEY_TAG = 'vivid-connection'
/** The comment of the one key an installation used before keys belonged to connections. A line
 * with it is Vivid's too, and is removed the same way. */
const RETIRED_KEY_TAG = 'vivid'

/** One connection's key pair. The private half never leaves `Redacted` except into the client. */
export interface Identity {
  readonly privateKey: Redacted.Redacted
  /** One `authorized_keys` line: the type, the key, and `KEY_TAG`. */
  readonly publicKey: string
}

/**
 * A key pair for ONE opening of ONE machine, made in memory (ed25519, about 1.5 ms). It is never
 * a setting, never stored, never logged, and never used for a second opening or a second
 * machine: a key shared by machines would let whoever holds one Person's machine reach every
 * other Person's. A Person never holds it either; a Person's own SSH access to their Computer, if
 * it is ever built, is that Person's own key.
 */
export const connectionIdentity: Effect.Effect<Identity, LinkKeyRefused> = Effect.suspend(() => {
  // ssh2 1.17.0 now and then writes an ed25519 private key that its own reader refuses
  // ("Malformed OpenSSH private key": 15 of 3,000 on 5 October 2026). A pair is used only when
  // the reader that will log in with it accepts it; eight refusals in a row do not happen.
  for (let tries = 0; tries < 8; tries += 1) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519')
    const parsed = ssh2.utils.parseKey(pair.private)
    if (parsed instanceof Error || Array.isArray(parsed)) continue
    return Effect.succeed({
      privateKey: Redacted.make(pair.private),
      publicKey: `${parsed.type} ${parsed.getPublicSSH().toString('base64')} ${KEY_TAG}`,
    })
  }
  return Effect.fail(new LinkKeyRefused())
})

/**
 * Removes from the machine's authorized keys every line of Vivid's except this connection's, and
 * keeps every other line (the Person's own keys, the provider's tools). A key line outlives its
 * connection, so without this they pile up, and each is a key that still opens the machine.
 *
 * A line is Vivid's only when it is exactly "type key comment" with one of Vivid's two comments;
 * a line with options or any other comment is someone else's and is copied as it is. The file is
 * rewritten through a temporary file beside it, given the file's own mode, and moved into place;
 * it is never truncated where it is, and not touched at all when there is nothing to remove. `file` is absolute or relative to the user's home.
 *
 * This relies on one server holding a machine's connection at a time: two servers opening the
 * same machine would each remove the other's line. A connection that is already open is not
 * affected when its line goes; only a new login reads the file.
 *
 * It answers whether it worked and never fails: the caller's command does not depend on it. No
 * key material is in what it answers.
 */
export const pruneKeys = Effect.fn('Link.pruneKeys')(function* (
  link: Link,
  identity: Identity,
  file: string,
) {
  const [, current] = identity.publicKey.split(' ')
  // Vivid's line is exactly "type key comment": a real key type first, so a comment line that
  // happens to end in the tag is not taken for one.
  const mine =
    'NF == 3 && $1 ~ /^(ssh-|ecdsa-|sk-)/ && ($3 == tag || $3 == old) && $2 != keep { next } { print }'
  const script = [
    'cd "$HOME" || exit 1',
    `file=${shellWord(file)}`,
    '[ -f "$file" ] || exit 0',
    'seen=$(cksum < "$file") || exit 1',
    'next=$(mktemp "$(dirname "$file")/.keys.XXXXXX") || exit 1',
    `awk -v keep=${shellWord(String(current))} -v tag=${shellWord(KEY_TAG)} -v old=${shellWord(RETIRED_KEY_TAG)} '${mine}' "$file" > "$next" || { rm -f "$next"; exit 1; }`,
    // Nothing of Vivid's to remove: the file is left exactly as it is, mode and all.
    'if cmp -s "$file" "$next"; then rm -f "$next"; exit 0; fi',
    // The file keeps the mode it had; a new file would otherwise take the temporary one's.
    'chmod --reference="$file" "$next" || { rm -f "$next"; exit 1; }',
    // Someone else (the provider letting a key in, the Person) wrote the file since it was read:
    // their line is not in the copy, so the copy is dropped and the next opening tries again.
    // What is left is the instant between this check and the move; nothing here can lock the
    // provider's writer out.
    'if [ "$(cksum < "$file")" != "$seen" ]; then rm -f "$next"; exit 0; fi',
    'mv "$next" "$file" || { rm -f "$next"; exit 1; }',
  ].join('\n')
  const run = yield* Effect.result(
    link.run({ command: script, directory: '/', timeoutSeconds: 20 }),
  )
  return Result.isSuccess(run) && run.success.exitCode === 0
})

/** Keeps the last `OUTPUT_BYTES` of a stream as it arrives, so a flood cannot hold memory. */
const tail = () => {
  let kept: ReadonlyArray<NodeBuffer.Buffer> = []
  let size = 0
  let cut = false
  return {
    add: (piece: NodeBuffer.Buffer) => {
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
      const all = NodeBuffer.Buffer.concat(kept)
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
  Predicate.isNumber(error.code)
    ? new LinkFileRefused({ reason: refusal(error) })
    : new LinkUnreachable()

const directoryOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0))

/** Every directory from the top down to `path`, as `mkdir -p` would visit them. */
const ancestors = (path: string): ReadonlyArray<string> => {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)
}

/**
 * The calls that are waiting on the connection. A closed connection answers none of them (ssh2
 * drops the callbacks of a closed SFTP channel), so each waiting call registers how to be told,
 * and `lost` tells them all once.
 */
const waiting = () => {
  let open = true
  const told = new Set<() => void>()
  /** One library call. `start` gets `settle`, which only the first of the answer or the loss
   * uses; a call made on a closed connection is told at once and never reaches the library. */
  const call = <A, E>(
    gone: E,
    start: (settle: (answer: Effect.Effect<A, E>) => void) => void,
  ): Effect.Effect<A, E> =>
    Effect.callback<A, E>((resume) => {
      let settled = false
      const settle = (answer: Effect.Effect<A, E>) => {
        if (settled) return
        settled = true
        told.delete(tell)
        resume(answer)
      }
      const tell = () => settle(Effect.fail(gone))
      if (!open) return tell()
      told.add(tell)
      start(settle)
      return Effect.sync(() => {
        settled = true
        told.delete(tell)
      })
    })
  return {
    alive: () => open,
    lost: () => {
      open = false
      for (const tell of told) tell()
      told.clear()
    },
    call,
  }
}
type Waiting = ReturnType<typeof waiting>

const files = (sftp: SFTPWrapper, calls: Waiting) => {
  type Refused = LinkUnreachable | LinkFileRefused
  const gone: Refused = new LinkUnreachable()
  const stat = (path: string) =>
    calls.call<{ readonly size: number; readonly directory: boolean }, Refused>(gone, (settle) => {
      sftp.stat(path, (error, stats) => {
        if (error !== undefined && error !== null) return settle(Effect.fail(fileFailure(error)))
        return settle(Effect.succeed({ size: stats.size, directory: stats.isDirectory() }))
      })
    })
  const read = Effect.fn('Link.read')(function* (path: string) {
    // Asked first: a read answers the whole file, and one that is too large must not be fetched.
    const found = yield* stat(path)
    if (found.directory) return yield* Effect.fail(new LinkFileRefused({ reason: 'directory' }))
    if (found.size > FILE_BYTES) return yield* Effect.fail(new LinkFileRefused({ reason: 'large' }))
    return yield* calls.call<Uint8Array, Refused>(gone, (settle) => {
      sftp.readFile(path, (error, data) => {
        if (error !== undefined && error !== null) return settle(Effect.fail(fileFailure(error)))
        return settle(Effect.succeed(new Uint8Array(data)))
      })
    })
  })
  /**
   * One level. SFTP has no code for "it is already there" (OpenSSH answers the general failure,
   * 4), so a refusal is believed only when the directory is in truth not there: then the refusal
   * itself is the answer (no permission, a file in the way), and a lost connection stays lost.
   */
  const make = Effect.fn('Link.make')(function* (path: string) {
    const made = yield* Effect.result(
      calls.call<void, Refused>(gone, (settle) => {
        sftp.mkdir(path, (error) => {
          if (error !== undefined && error !== null) return settle(Effect.fail(fileFailure(error)))
          return settle(Effect.void)
        })
      }),
    )
    if (Result.isSuccess(made)) return undefined
    if (made.failure instanceof LinkUnreachable) return yield* Effect.fail(made.failure)
    const there = yield* Effect.result(stat(path))
    if (Result.isSuccess(there) && there.success.directory) return undefined
    return yield* Effect.fail(made.failure)
  })
  const write = (path: string, content: Uint8Array) =>
    calls.call<void, Refused>(gone, (settle) => {
      sftp.writeFile(path, NodeBuffer.Buffer.from(content), (error) => {
        if (error !== undefined && error !== null) return settle(Effect.fail(fileFailure(error)))
        return settle(Effect.void)
      })
    })
  const put = Effect.fn('Link.put')(function* (path: string, content: Uint8Array) {
    if (content.length > FILE_BYTES)
      return yield* Effect.fail(new LinkFileRefused({ reason: 'large' }))
    // Straight first: the directory nearly always exists, and that is one round trip.
    const direct = yield* Effect.result(write(path, content))
    if (Result.isSuccess(direct)) return undefined
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
 * passes to the group in the same way; if the channel opens only after the caller has gone, it is
 * ended the moment it opens. This side also stops waiting a little after the deadline, so a
 * machine that never answers cannot hold the caller.
 *
 * A command has ended only when the machine said so (an exit status or a signal). A channel that
 * closes without either is a connection that went: the command may be running still, which is
 * `LinkRunLost`, never an ending.
 */
const runner =
  (client: Client, calls: Waiting): Link['run'] =>
  ({ command, directory, timeoutSeconds }) => {
    const stdout = tail()
    const stderr = tail()
    let channel = Option.none<ClientChannel>()
    let stopped = false
    const stop = () => {
      stopped = true
      Option.map(channel, (open) => {
        open.signal('TERM')
        open.close()
      })
    }
    // A login shell, as a person at the machine has: their PATH and their profile.
    const script = `cd -- ${shellWord(directory)} || exit 1\n${command}`
    const started = Date.now()
    return calls
      .call<LinkRun, LinkUnreachable | LinkRunLost>(new LinkRunLost(), (settle) => {
        const done = (exitCode: number | null, timedOut: boolean) => {
          clearTimeout(timer)
          const out = stdout.text()
          const err = stderr.text()
          settle(
            Effect.succeed({
              stdout: out.text,
              stderr: err.text,
              exitCode: timedOut ? null : exitCode,
              timedOut,
              truncated: out.cut || err.cut,
            }),
          )
        }
        const timer = setTimeout(
          () => {
            stop()
            done(null, true)
          },
          (timeoutSeconds + GRACE_SECONDS + 3) * 1000,
        )
        client.exec(
          `exec timeout -k ${GRACE_SECONDS} ${timeoutSeconds} bash -lc ${shellWord(script)}`,
          (error, opened) => {
            if (error !== undefined && error !== null) {
              clearTimeout(timer)
              return settle(Effect.fail(new LinkUnreachable()))
            }
            channel = Option.some(opened)
            if (stopped) return stop()
            let ended = Option.none<number | null>()
            opened.on('data', stdout.add)
            opened.stderr.on('data', stderr.add)
            // The machine's own word that the command ended: a status, or the signal that
            // ended it (then there is no status).
            opened.on('exit', (code: number | null) => {
              ended = Option.some(Predicate.isNumber(code) ? code : null)
            })
            opened.on('close', () => {
              clearTimeout(timer)
              if (Option.isNone(ended)) return settle(Effect.fail(new LinkRunLost()))
              const code = ended.value
              // `timeout` answers 124 when it ended the command, 137 when it had to kill it. A
              // command may exit with those codes itself, so the clock decides which it was.
              const expired =
                (code === 124 || code === 137) && Date.now() - started >= timeoutSeconds * 1000
              return done(code, expired)
            })
            return undefined
          },
        )
      })
      .pipe(Effect.onInterrupt(() => Effect.sync(stop)))
  }

/** The file subsystem is opened once per connection and shared by every read and put. */
const subsystem = (client: Client, calls: Waiting) =>
  calls.call<SFTPWrapper, LinkUnreachable>(new LinkUnreachable(), (settle) => {
    client.sftp((error, sftp) => {
      if (error !== undefined && error !== null) return settle(Effect.fail(new LinkUnreachable()))
      return settle(Effect.succeed(sftp))
    })
  })

/** The key the host presents, compared with the one the provider reported, byte for byte.
 * `expected` is an OpenSSH public key line; its second word is the wire encoding ssh2 passes. */
const sameHost = (expected: string, presented: NodeBuffer.Buffer) => {
  const [, encoded] = expected.trim().split(/\s+/)
  return encoded !== undefined && NodeBuffer.Buffer.from(encoded, 'base64').equals(presented)
}

/** The scope that holds a connection destroys it when it closes. */
const closing = (client: Client) => Effect.addFinalizer(() => Effect.sync(() => client.destroy()))

/**
 * Opens the connection and holds it for the scope. A machine that has just been woken refuses
 * connections for a while, so the caller retries this; nothing here waits or retries. The wait
 * for the host ends on its first answer of any kind: ready, an error, or the host closing before
 * it was ready, which ssh2 reports as a close and not as an error. Giving up closes the socket.
 */
export const openLink = Effect.fn('Link.open')(function* (input: {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly identity: Identity
  readonly hostKey: string
}): Effect.fn.Return<Link, LinkFailure, Scope.Scope> {
  const calls = waiting()
  const dialled = Effect.callback<Client, LinkFailure>((resume) => {
    const connection = new ssh2.Client()
    let mismatch = false
    let settled = false
    const settle = (answer: Effect.Effect<Client, LinkFailure>) => {
      if (settled) return
      settled = true
      resume(answer)
    }
    const refused = (failure: LinkFailure) => {
      connection.destroy()
      settle(Effect.fail(failure))
    }
    connection.once('ready', () => settle(Effect.succeed(connection)))
    connection.on('error', (error: Error & { readonly level?: string }) => {
      if (mismatch) return refused(new LinkHostMismatch())
      if (error.level === 'client-authentication') return refused(new LinkKeyRefused())
      return refused(new LinkUnreachable())
    })
    // After it was ready this is the connection going; before, the host hung up on us.
    connection.on('close', () => {
      calls.lost()
      settle(Effect.fail(mismatch ? new LinkHostMismatch() : new LinkUnreachable()))
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
      hostVerifier: (presented: NodeBuffer.Buffer) => {
        mismatch = !sameHost(input.hostKey, presented)
        return !mismatch
      },
    })
    return Effect.sync(() => connection.destroy())
  })
  // Only the wait can be interrupted (it then destroys its own socket, above). Once the host has
  // answered "ready", registering the close with the scope is not interruptible: an interruption
  // between the two would leave an open connection that nothing closes.
  const client = yield* Effect.uninterruptibleMask((restore) =>
    Effect.tap(restore(dialled), closing),
  )
  const sftp = yield* subsystem(client, calls)
  const { read, put } = files(sftp, calls)
  return { run: runner(client, calls), alive: calls.alive, read, put }
})
