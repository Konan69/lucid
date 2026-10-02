import { describe, expect, it } from '@effect/vitest'
import {
  Conflict,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable,
  Forbidden,
  InvalidRequest,
  NotFound,
  RuntimeUnavailable,
  ServiceUnavailable,
  Unauthenticated,
} from '@vivid/contracts'
import { Cause, Config, ConfigProvider, Effect, Exit } from 'effect'
import { RpcClientDefect, RpcClientError } from 'effect/unstable/rpc/RpcClientError'
import { boundOutput, settle } from './result.ts'

describe('output limits', () => {
  it.effect('caps nested lists and text while marking both the affected record and the root', () =>
    Effect.sync(() => {
      const source = {
        tools: Array.from({ length: 30 }, (_, index) => ({
          name: `tool-${index}`,
          description: 'a'.repeat(4100),
          input: { required: Array.from({ length: 26 }, (_field, field) => `field-${field}`) },
        })),
      }
      const expected = {
        tools: source.tools.slice(0, 25).map((tool) => ({
          name: tool.name,
          description: 'a'.repeat(4000),
          input: { required: tool.input.required.slice(0, 25), truncated: true },
          truncated: true,
        })),
        truncated: true,
      }
      expect(boundOutput(source)).toEqual(expected)
      expect(source.tools).toHaveLength(30)
      expect(source.tools[0]).toHaveProperty('description', 'a'.repeat(4100))
    }),
  )

  it.effect('keeps small outputs exact and preserves a server’s existing truncation marker', () =>
    Effect.sync(() => {
      const value = {
        kind: 'connection-request',
        ready: false,
        service: 'mail',
        nested: { output: 'short', truncated: true },
        numbers: [1, null, false],
      }
      expect(boundOutput(value)).toEqual(value)
      expect(
        boundOutput({
          text: 'a'.repeat(4000),
          items: Array.from({ length: 25 }, (_, index) => index),
        }),
      ).toEqual({ text: 'a'.repeat(4000), items: Array.from({ length: 25 }, (_, index) => index) })
    }),
  )

  it.effect('marks scalar and list roots without silently dropping data', () =>
    Effect.sync(() => {
      expect(boundOutput('x'.repeat(4001))).toEqual({ value: 'x'.repeat(4000), truncated: true })
      expect(boundOutput(Array.from({ length: 26 }, (_, index) => index))).toEqual({
        value: Array.from({ length: 25 }, (_, index) => index),
        truncated: true,
      })
    }),
  )
})

describe('RPC result boundary', () => {
  it.effect('turns every declared product failure into a safe, bounded output', () =>
    Effect.gen(function* () {
      const message = 'Private driver payload that must never reach the model'
      const failures = [
        new NotFound({ message }),
        new Forbidden({ message }),
        new Unauthenticated({ message }),
        new Conflict({ message }),
        new InvalidRequest({ message }),
        new RuntimeUnavailable({ message }),
        new DatabaseUnavailable({ message }),
        new DatabaseConstraintViolation({ message }),
        new DatabaseFailure({ message }),
        new ServiceUnavailable({ service: 'memory', message }),
      ]
      for (const failure of failures) {
        const result = yield* settle(Effect.fail(failure))
        expect(result.output).toHaveProperty('ok', false)
        expect(JSON.stringify(result.output)).not.toContain(message)
        expect(result.terminate).toBe(false)
      }
      expect((yield* settle(Effect.fail(new NotFound({ message })))).output).toEqual({
        ok: false,
        message: 'It does not exist or the person cannot see it.',
      })
    }),
  )

  it.effect('returns fixed safe sentences for transport and configuration failures', () =>
    Effect.gen(function* () {
      const failure = new RpcClientError({
        reason: new RpcClientDefect({ message: 'Malformed RPC response', cause: null }),
      })
      const expected = {
        output: {
          ok: false,
          message: 'Vivid cannot reach its server right now; try again in a moment.',
        },
        terminate: false,
      }
      expect(yield* settle(Effect.fail(failure))).toEqual(expected)
      const configuration = Config.String('REQUIRED').pipe(
        Effect.map((value) => ({ output: value })),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      )
      expect(yield* settle(configuration)).toEqual(expected)
    }),
  )

  it.effect('keeps defects out of the safe-failure recovery path', () =>
    Effect.gen(function* () {
      const defect = new TypeError('Tool invariant failed')
      const exit = yield* Effect.exit(settle(Effect.die(defect)))
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }),
  )

  it.effect('returns a boolean stop flag for ordinary results so Flue accepts the envelope', () =>
    Effect.gen(function* () {
      expect(yield* settle(Effect.succeed({ output: { tasks: [] } }))).toEqual({
        output: { tasks: [] },
        terminate: false,
      })
    }),
  )

  it.effect('bounds successful data while keeping the framework stop signal', () =>
    Effect.gen(function* () {
      expect(
        yield* settle(
          Effect.succeed({
            output: {
              kind: 'approval-request',
              approvalId: 'approval-1',
              summary: 's'.repeat(5000),
            },
            terminate: true,
          }),
        ),
      ).toEqual({
        output: {
          kind: 'approval-request',
          approvalId: 'approval-1',
          summary: 's'.repeat(4000),
          truncated: true,
        },
        terminate: true,
      })
    }),
  )
})
