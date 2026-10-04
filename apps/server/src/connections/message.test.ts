import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  MAX_VALIDATION_PROBLEMS,
  MAX_VALIDATION_PROBLEM_LENGTH,
  toolMessage,
  validationProblems,
} from './message.ts'

it.effect('keeps arbitrary semantic errors out of both model call paths', () =>
  Effect.sync(() => {
    expect(toolMessage({ isError: true, token: 'private-value' })).not.toContain('private-value')
  }),
)

it.effect(
  'preserves tool field paths and removes only known internal references before bounding',
  () =>
    Effect.sync(() => {
      const fields = [
        'owner',
        'id',
        'account',
        'profile',
        'organization',
        'key',
        'token',
        'x'.repeat(30),
      ]
      expect(validationProblems(fields, ['internal-app'])).toEqual(fields)
      expect(
        validationProblems(
          ['id internal-app internal-profile internal-account internal-deployment'],
          ['internal-app', 'internal-profile', 'internal-account', 'internal-deployment'],
        ),
      ).toEqual(['id [REDACTED] [REDACTED] [REDACTED] [REDACTED]'])
      const bounded = validationProblems(
        Array.from({ length: 20 }, () => 'x'.repeat(1000)),
        [],
      )
      expect(bounded).toHaveLength(MAX_VALIDATION_PROBLEMS)
      expect(bounded.every((problem) => problem.length === MAX_VALIDATION_PROBLEM_LENGTH)).toBe(
        true,
      )
    }),
)
