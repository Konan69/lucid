import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import { describe, expect, it } from '@effect/vitest'
import { onTestFinished } from 'vitest'
import { HELD, holderClaim, snapshotRules, UNSETTLED } from './boat/holder.ts'
import * as Protocol from './boat/protocol.ts'

const machine = Protocol.ProviderId.make('bx_23456789')
const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
/** Sixteen bindings that all want the machine at once. */
const rivals = Array.from({ length: 16 }, (_, index) => {
  const digit = index.toString(16)
  return `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`
})

/**
 * The claim is shell that runs on the machine, so it is run here by real shells against a home
 * directory of its own: the record is a file, and what matters is what the file says afterwards.
 * `sh` is the least a machine can have; `bash` is what Boat's machines run commands with.
 */
describe.each(['sh', 'bash'])('the machine’s holder record under %s', (shell) => {
  /** Remove only this fixture's directory, including when a claim or assertion fails. */
  const home = () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-holder-'))
    onTestFinished(() => NodeFS.rmSync(directory, { recursive: true, force: true }))
    return directory
  }
  const claim = (directory: string, intent: string) =>
    NodeChildProcess.spawnSync(shell, ['-c', holderClaim({ id: machine, intent })], {
      env: { HOME: directory, PATH: NodeProcess.env['PATH'] },
    }).status
  const record = (directory: string) =>
    NodeFS.readFileSync(NodePath.join(directory, '.vivid', 'holder'), 'utf8')

  /**
   * The rules are shell too, and what matters is the file a Computer ends up with: Boat reads
   * `.boxignore` in the home directory and leaves what it names out of every snapshot.
   */
  it('gives a Computer its snapshot rules once and never rewrites a file that is there', () => {
    const directory = home()
    const rules = () =>
      NodeChildProcess.spawnSync(shell, ['-c', snapshotRules], {
        env: { HOME: directory, PATH: NodeProcess.env['PATH'] },
      }).status
    const file = NodePath.join(directory, '.boxignore')
    expect(rules()).toBe(0)
    const written = NodeFS.readFileSync(file, 'utf8').split('\n')
    // Caches a tool fills again are left out; a project's own dependency tree is not named.
    expect(written).toContain('.cache/')
    expect(written).toContain('.local/share/pnpm/store/')
    expect(written.some((line) => line.includes('node_modules'))).toBe(false)
    expect(NodeFS.existsSync(`${file}.new`)).toBe(false)
    NodeFS.writeFileSync(file, 'mine/\n')
    expect(rules()).toBe(0)
    expect(NodeFS.readFileSync(file, 'utf8')).toBe('mine/\n')
  })

  it('makes the first binding the holder and lets it on again', () => {
    const directory = home()
    expect(claim(directory, first)).toBe(0)
    expect(record(directory)).toBe(`${machine} ${first}\n`)
    expect(claim(directory, first)).toBe(0)
    expect(record(directory)).toBe(`${machine} ${first}\n`)
  })

  it('refuses another binding and keeps the holder', () => {
    const directory = home()
    expect(claim(directory, first)).toBe(0)
    expect(claim(directory, second)).toBe(HELD)
    expect(record(directory)).toBe(`${machine} ${first}\n`)
  })

  const seeded = (content: string) => {
    const directory = home()
    NodeFS.mkdirSync(NodePath.join(directory, '.vivid'))
    NodeFS.writeFileSync(NodePath.join(directory, '.vivid', 'holder'), content)
    return directory
  }

  it('replaces a record that is another machine’s', () => {
    const directory = seeded(`bx_abcdefgh ${second}\n`)
    expect(claim(directory, first)).toBe(0)
    expect(record(directory)).toBe(`${machine} ${first}\n`)
  })

  /**
   * A record that is not exactly one machine id and one intent is damage. It is not a free
   * machine, so nobody takes it, and it is not another account's claim, so the status is not
   * `HELD` and no server gives its binding up over it. The file is left as it was found.
   */
  it('settles nothing on a damaged record and leaves it as it was', () => {
    const damaged = [
      '',
      '\n',
      `${machine}\n`,
      `${machine} ${first} \n`,
      `${machine} ${first}\r\n`,
      `${machine}  ${first}\n`,
      `${machine} ${first}\n${machine} ${second}\n`,
      `${machine} ${first.slice(1)}\n`,
      `machine ${first}\n`,
      `bx_ABCDEFGH ${first}\n`,
      // Outside the characters Boat makes an id from.
      `bx_0000000a ${first}\n`,
      // The right length and the right characters, and not an intent.
      `${machine} ${'-'.repeat(36)}\n`,
      `${machine} AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n`,
      // A whole record with something after it: reading it must not tidy that away.
      `${machine} ${first}\n\n`,
      `${machine} ${first}\0\n`,
    ]
    for (const content of damaged) {
      const directory = seeded(content)
      expect([content, claim(directory, second)]).toEqual([content, UNSETTLED])
      expect(record(directory)).toBe(content)
    }
  })

  it('settles nothing when the record cannot be read', () => {
    const directory = home()
    // A directory where the record should be: the read fails for every user, root included.
    NodeFS.mkdirSync(NodePath.join(directory, '.vivid', 'holder'), { recursive: true })
    expect(claim(directory, first)).toBe(UNSETTLED)
    expect(NodeFS.statSync(NodePath.join(directory, '.vivid', 'holder')).isDirectory()).toBe(true)
  })

  /**
   * Two servers can reach a machine in the same instant. All the claims here are started
   * together by one shell and run as separate processes against the same home, first on a
   * machine with no record and then on one whose record came with a copied disk. Exactly one
   * may win, and the record must name that one.
   */
  it('gives the machine to exactly one of many bindings that claim it at once', () => {
    for (const before of ['', `bx_abcdefgh ${second}\n`]) {
      for (let round = 0; round < 5; round++) {
        const directory = before === '' ? home() : seeded(before)
        const together = rivals
          .map(
            (intent, index) =>
              `( ( ${holderClaim({ id: machine, intent })}\n ); echo "$?" > "$HOME/exit.${index}" ) &`,
          )
          .join('\n')
        NodeChildProcess.spawnSync(shell, ['-c', `${together}\nwait`], {
          env: { HOME: directory, PATH: NodeProcess.env['PATH'] },
        })
        const exits = rivals.map((_, index) =>
          Number(NodeFS.readFileSync(NodePath.join(directory, `exit.${index}`), 'utf8')),
        )
        const winners = rivals.filter((_, index) => exits[index] === 0)
        expect(winners).toHaveLength(1)
        expect(exits.filter((status) => status === HELD)).toHaveLength(rivals.length - 1)
        expect(winners.map((intent) => `${machine} ${intent}\n`)).toEqual([record(directory)])
      }
    }
  })

  it('leaves the lock free for whatever runs after it', () => {
    const directory = home()
    // What follows the claim in a wake lives for the whole session; it must not hold the lock.
    const after = NodeChildProcess.spawnSync(
      shell,
      [
        '-c',
        `${holderClaim({ id: machine, intent: first })}\nflock -n "$HOME/.vivid/holder.lock" true`,
      ],
      { env: { HOME: directory, PATH: NodeProcess.env['PATH'] } },
    )
    expect(after.status).toBe(0)
  })
})
