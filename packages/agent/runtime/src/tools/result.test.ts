import { describe, expect, it } from '@effect/vitest'
import {
  ComputerScreen,
  Conflict,
  DatabaseConstraintViolation,
  DatabaseFailure,
  DatabaseUnavailable,
  Forbidden,
  InvalidRequest,
  NotFound,
  NoDeviceConnected,
  RuntimeUnavailable,
  ServiceUnavailable,
  Unauthenticated,
} from '@vivid/contracts'
import { Cause, Config, ConfigProvider, Effect, Exit, Logger } from 'effect'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import { boundOutput, settle } from './result.ts'

describe('output limits', () => {
  it.effect('publishes the scoped viewer receipt only after successful Computer work', () =>
    Effect.gen(function* () {
      const completed = yield* settle(
        Effect.succeed({ output: { ok: true, result: { outline: 'Received!' } } }),
        'browse',
      )
      expect(completed.output).toEqual({
        ok: true,
        result: { outline: 'Received!' },
        computer: {
          active: true,
          screen: ComputerScreen.cases.Relay.make({ address: '/api/computer/screen/websockify' }),
        },
      })
      const refused = yield* settle(
        Effect.succeed({ output: { ok: false, message: 'Unavailable' } }),
        'browse',
      )
      expect(refused.output).not.toHaveProperty('computer')
      const unrelated = yield* settle(Effect.succeed({ output: { ok: true } }), 'read_page')
      expect(unrelated.output).not.toHaveProperty('computer')
    }),
  )
  it.effect(
    'preserves bounded program values, logs and 100 receipts through the model boundary',
    () =>
      Effect.gen(function* () {
        const output = {
          ok: true,
          result: 'x'.repeat(5000),
          logs: ['y'.repeat(6000)],
          logsTruncated: false,
          calls: Array.from({ length: 100 }, () => ({
            kind: 'find_tools',
            summary: 'Read tools',
            end: 'completed',
          })),
          truncated: false,
        }
        expect((yield* settle(Effect.succeed({ output }), 'run_code')).output).toEqual(output)
        const ordinary = (yield* settle(Effect.succeed({ output }), 'read_page')).output
        expect(ordinary).toHaveProperty('result', 'x'.repeat(4000))
        expect(ordinary).toHaveProperty('calls.length', 25)
      }),
  )
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
  it.effect(
    'logs one warning with the tool and tag, without failure payloads or successful results',
    () =>
      Effect.gen(function* () {
        const logs: string[] = []
        const logger = Logger.make(({ message, logLevel }) => {
          logs.push(JSON.stringify({ message, logLevel }))
        })
        yield* Effect.gen(function* () {
          yield* settle(
            Effect.fail(
              new ServiceUnavailable({
                service: 'connections',
                message: 'secret-token-and-private-output',
              }),
            ),
            'create_routine',
          )
          yield* settle(Effect.succeed({ output: 'private-successful-output' }), 'read_page')
        }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
        expect(logs).toHaveLength(1)
        expect(logs[0]).toContain('Warn')
        expect(logs[0]).toContain('create_routine')
        expect(logs[0]).toContain('ServiceUnavailable')
        expect(logs[0]).not.toMatch(/private|secret|read_page/u)
      }),
  )
  it.effect('turns every declared product failure into a safe, bounded output', () =>
    Effect.gen(function* () {
      const message = 'Private driver payload that must never reach the model'
      const failures = [
        { failure: new NoDeviceConnected({}), expected: 'The Person’s computer is not connected.' },
        {
          failure: new NotFound({ message }),
          expected: 'It does not exist or the person cannot see it.',
        },
        {
          failure: new Forbidden({ message }),
          expected: 'The person is not allowed to do that here.',
        },
        {
          failure: new Unauthenticated({ message }),
          expected: 'The person needs to sign in before Vivid can do that.',
        },
        {
          failure: new Conflict({ message }),
          expected: 'The request conflicts with the current state; check it before trying again.',
        },
        {
          failure: new InvalidRequest({ message }),
          expected: 'The request is invalid; check the supplied details.',
        },
        {
          failure: new RuntimeUnavailable({ message }),
          expected: 'Vivid cannot start that work right now.',
        },
        {
          failure: new DatabaseUnavailable({ message }),
          expected: 'Vivid cannot reach its saved records right now.',
        },
        {
          failure: new DatabaseConstraintViolation({ message }),
          expected: 'The request conflicts with Vivid’s saved records.',
        },
        {
          failure: new DatabaseFailure({ message }),
          expected: 'Vivid could not read or save that record right now.',
        },
        {
          failure: new ServiceUnavailable({ service: 'memory', message }),
          expected: 'That part of Vivid is not available right now.',
        },
      ]
      for (const { failure, expected } of failures) {
        expect(yield* settle(Effect.fail(failure), 'test-tool')).toEqual({
          output: { ok: false, message: expected },
          terminate: false,
        })
      }
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
      expect(yield* settle(Effect.fail(failure), 'test-tool')).toEqual(expected)
      const configuration = Config.String('REQUIRED').pipe(
        Effect.map((value) => ({ output: value })),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      )
      expect(yield* settle(configuration, 'test-tool')).toEqual(expected)
    }),
  )

  it.effect('keeps defects out of the safe-failure recovery path', () =>
    Effect.gen(function* () {
      const defect = new TypeError('Tool invariant failed')
      const exit = yield* Effect.exit(settle(Effect.die(defect), 'test-tool'))
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
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
          'test-tool',
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
