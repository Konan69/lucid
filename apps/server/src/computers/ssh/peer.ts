import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import { Effect, Redacted } from 'effect'
import { utils } from 'ssh2'
import { identity } from './link.ts'

/** Where OpenSSH's server is on a Debian or Ubuntu machine; a suite that needs a peer is skipped
 * where it is not installed. */
export const SSHD = '/usr/sbin/sshd'
export const peerAvailable = NodeFS.existsSync(SSHD)

const keygen = (file: string) =>
  NodeChildProcess.execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file])

/**
 * A real SSH server for tests: OpenSSH's `sshd`, run by the current user on a free local port,
 * with its own host key and one authorized key, all in a directory that is removed afterwards.
 *
 * It is a real protocol peer and a real shell and file system, which is what the SSH code claims
 * to speak to. It is not a Vivid Computer: no provider wakes it and its address does not change.
 * `home` is a fresh directory, so a test's files never touch the developer's own.
 */
export const peer = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-ssh-'))),
    (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true, force: true })),
  )
  const home = NodePath.join(root, 'home')
  NodeFS.mkdirSync(home)
  keygen(NodePath.join(root, 'host'))
  keygen(NodePath.join(root, 'client'))
  NodeFS.copyFileSync(NodePath.join(root, 'client.pub'), NodePath.join(root, 'authorized'))
  NodeFS.writeFileSync(
    NodePath.join(root, 'config'),
    [
      'ListenAddress 127.0.0.1',
      // Port 0 is not accepted by sshd; the kernel picks a free one for `listen` below instead.
      `HostKey ${NodePath.join(root, 'host')}`,
      `AuthorizedKeysFile ${NodePath.join(root, 'authorized')}`,
      `PidFile ${NodePath.join(root, 'pid')}`,
      'PasswordAuthentication no',
      'UsePAM no',
      'StrictModes no',
      'Subsystem sftp internal-sftp',
      '',
    ].join('\n'),
  )
  const port = yield* freePort
  const child = yield* Effect.acquireRelease(
    Effect.callback<NodeChildProcess.ChildProcess>((resume) => {
      const started = NodeChildProcess.spawn(
        SSHD,
        ['-D', '-e', '-f', NodePath.join(root, 'config'), '-p', String(port)],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
      started.stderr.setEncoding('utf8')
      // sshd says when its socket is open; that line is the signal, not a delay.
      started.stderr.on('data', (text: string) => {
        if (text.includes('Server listening')) resume(Effect.succeed(started))
      })
      started.on('exit', () => resume(Effect.die('The test SSH server did not start')))
    }),
    // The captured child only.
    (started) => Effect.sync(() => started.kill('SIGTERM')),
  )
  const key = yield* identity(
    Redacted.make(NodeFS.readFileSync(NodePath.join(root, 'client'), 'utf8')),
  )
  const stranger = yield* Effect.sync(() => {
    keygen(NodePath.join(root, 'stranger'))
    return NodeFS.readFileSync(NodePath.join(root, 'stranger.pub'), 'utf8').trim()
  })
  return {
    child,
    home,
    host: '127.0.0.1',
    port,
    user: NodeOS.userInfo().username,
    identity: key,
    hostKey: NodeFS.readFileSync(NodePath.join(root, 'host.pub'), 'utf8').trim(),
    /** A valid host key that is not this server's. */
    stranger,
  }
})

/** A port the kernel says is free now. Another process could take it before sshd binds; sshd then
 * exits and the fixture fails loudly, it never connects to the other process (host key check). */
const freePort = Effect.callback<number>((resume) => {
  const server = NodeChildProcess.spawn(
    process.execPath,
    [
      '-e',
      "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  let text = ''
  server.stdout.setEncoding('utf8')
  server.stdout.on('data', (piece: string) => {
    text += piece
  })
  server.on('close', () => resume(Effect.succeed(Number(text.trim()))))
})

/**
 * A key made now, in the form the `VIVID_COMPUTER_SSH_KEY` setting takes (base64 of the private
 * key file). For suites that compose the provider and never connect; no key is checked in.
 */
export const throwawayKeySetting = () =>
  Buffer.from(utils.generateKeyPairSync('ed25519').private).toString('base64')
