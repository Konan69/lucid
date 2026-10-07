import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as Core from '../core.ts'
import { LimitInvalid, respond, respondTurn, streamRun } from '../main.ts'
import { context, host } from './fixtures/host.ts'

/** Invalid host policy fails before reading HTTP bytes or admitting an input on either entry. */
it.live.each([NaN, Infinity, -Infinity, -1, 1.5])(
  'rejects invalid byte policy %s at all ingresses',
  (value) =>
    Effect.gen(function* () {
      const opened = yield* Effect.promise(async () => (await host({}, {})).open())
      const options = { maxPartBytes: value }
      const turn = Core.ChatTurn.cases.Input.make({
        messageId: 'limit',
        parts: [{ type: 'text', text: 'Hello' }],
      })
      const input = {
        conversationId: opened.root.id,
        content: 'Hello',
        requestId: 'limit',
        options,
      }
      const failed = yield* Core.prepareRun(opened.harness, input, context).pipe(Effect.flip)
      expect(failed).toBeInstanceOf(LimitInvalid)
      expect(failed).toMatchObject({ value })
      expect(
        yield* Core.respond(opened.harness, opened.root.id, { turn, options }, context).pipe(
          Effect.flip,
        ),
      ).toBeInstanceOf(LimitInvalid)
      yield* Effect.promise(() =>
        expect(streamRun(opened.harness, input, context)).rejects.toBeInstanceOf(LimitInvalid),
      )
      yield* Effect.promise(() =>
        expect(
          respondTurn(opened.harness, opened.root.id, { turn, options }, context),
        ).rejects.toBeInstanceOf(LimitInvalid),
      )
      const request = new Request('http://durable.test/chat', { method: 'POST', body: 'not JSON' })
      yield* Effect.promise(() =>
        expect(
          respond(opened.harness, opened.root.id, { request, options }, context),
        ).rejects.toBeInstanceOf(LimitInvalid),
      )
      expect(request.bodyUsed).toBe(false)
      expect(opened.faux.state.callCount).toBe(0)
      expect(
        (yield* Effect.promise(() => opened.root.entries({}, 10, undefined, context))).items,
      ).toEqual([])
    }),
)
