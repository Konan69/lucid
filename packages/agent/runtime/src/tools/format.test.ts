import { describe, expect, it } from '@effect/vitest'
import { Option, Result } from 'effect'
import { reading, shell } from './format.ts'

/** Golden assertions are the Flue 2.2.2 result formatter's observable UTF-16 limits and wording.
 * They intentionally contain independent numbers/text so changing production constants fails. */
describe('Computer formatting parity', () => {
  it('keeps 2000 read lines and gives the next one-indexed offset', () => {
    const text = Array.from({ length: 2001 }, (_, index) => String(index + 1)).join('\n')
    const result = Result.getOrThrow(reading('a.txt', text, Option.none(), Option.none()))
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: `${text.split('\n').slice(0, 2000).join('\n')}\n\n[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]`,
        },
      ],
      details: { path: 'a.txt', lines: 2001 },
    })
    expect(
      Result.getOrThrow(reading('a.txt', text, Option.some(2001), Option.some(1))).content,
    ).toEqual([{ type: 'text', text: '2001' }])
  })

  it('counts characters, keeps whole lines and computes continuation from the actual offset', () => {
    const line = 'é'.repeat(25599)
    const result = Result.getOrThrow(
      reading('a.txt', `skip\n${line}\n${line}\nend`, Option.some(2), Option.none()),
    )
    expect(result.content).toEqual([
      {
        type: 'text',
        text: `${line}\n${line}\n\n[Showing lines 2-3 of 4. Use offset=4 to continue.]`,
      },
    ])
    expect(
      Result.getOrThrow(reading('a.txt', 'x'.repeat(51200), Option.none(), Option.none())).content,
    ).toEqual([{ type: 'text', text: 'x'.repeat(51200) }])
  })

  it('shows the first 51200 characters of an oversized first line with main’s warning', () => {
    expect(
      Result.getOrThrow(reading('a.txt', 'é'.repeat(51201), Option.none(), Option.none())).content,
    ).toEqual([
      {
        type: 'text',
        text: `${'é'.repeat(51200)}\n\n[Line 1 exceeds the 51200-byte read limit; showing the first 51200 bytes of it. The remainder of this line is not accessible via offset/limit.]`,
      },
    ])
  })

  it('preserves offset, limit and end-of-file refusal wording', () => {
    expect(
      Result.getOrThrow(reading('a.txt', 'one\ntwo\nthree', Option.some(2), Option.some(1)))
        .content,
    ).toEqual([{ type: 'text', text: 'two' }])
    const refusal = reading('a.txt', 'one\ntwo', Option.some(3), Option.none())
    expect(Result.isFailure(refusal) && refusal.failure.message).toBe(
      'Offset 3 is beyond end of file (2 lines total)',
    )
  })

  it('keeps the last 2000 bash lines and last 51200 characters', () => {
    const lines = Array.from({ length: 2001 }, (_, index) => String(index + 1))
    expect(shell({ stdout: lines.join('\n'), stderr: '', exitCode: 0 }, 'lines').content).toEqual([
      { type: 'text', text: lines.slice(-2000).join('\n') },
    ])
    expect(
      shell({ stdout: 'prefix' + 'é'.repeat(51200), stderr: '', exitCode: 0 }, 'long').content,
    ).toEqual([{ type: 'text', text: 'é'.repeat(51200) }])
  })

  it('joins stderr, trims output, and keeps the reference exit and empty-output text', () => {
    expect(shell({ stdout: '  out', stderr: 'err  ', exitCode: 124 }, 'run')).toEqual({
      content: [{ type: 'text', text: 'out\nerr\n\nCommand exited with code 124' }],
      details: { command: 'run', exitCode: 124 },
    })
    expect(shell({ stdout: '', stderr: '', exitCode: 0 }, 'true').content).toEqual([
      { type: 'text', text: '(no output)' },
    ])
  })
})
