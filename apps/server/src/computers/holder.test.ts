import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodeOS from 'node:os'
import * as NodePath from 'node:path'
import * as NodeProcess from 'node:process'
import { describe, expect, it } from '@effect/vitest'
import { HELD, holdable, holderClaim } from './boat/holder.ts'
import * as Protocol from './boat/protocol.ts'

const machine = Protocol.ProviderId.make('bx_23456789')
const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'

/**
 * The claim is shell that runs on the machine, so it is run here by real shells against a home
 * directory of its own: the record is a file, and what matters is what the file says afterwards.
 * `sh` is the least a machine can have; `bash` is what Boat's machines run commands with.
 */
describe.each(['sh', 'bash'])('the machine’s holder record under %s', (shell) => {
  const home = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), 'vivid-holder-'))
  const claim = (directory: string, intent: string) =>
    NodeChildProcess.spawnSync(shell, ['-c', holderClaim({ id: machine, intent })], {
      env: { HOME: directory, PATH: NodeProcess.env['PATH'] },
    }).status
  const record = (directory: string) =>
    NodeFS.readFileSync(NodePath.join(directory, '.vivid', 'holder'), 'utf8')

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

  it('replaces a record that is another machine’s, or cannot be read as one', () => {
    for (const stale of [`bx_abcdefgh ${second}\n`, '']) {
      const directory = home()
      NodeFS.mkdirSync(NodePath.join(directory, '.vivid'))
      NodeFS.writeFileSync(NodePath.join(directory, '.vivid', 'holder'), stale)
      expect(claim(directory, first)).toBe(0)
      expect(record(directory)).toBe(`${machine} ${first}\n`)
    }
  })
})

describe('what may be named on a machine', () => {
  it('is only an intent this server made', () => {
    expect(holdable(first)).toBe(true)
    for (const other of ['', 'intent', `${first}'; rm -rf ~ #`, `${first}\n`])
      expect(holdable(other)).toBe(false)
  })
})
