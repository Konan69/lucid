import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { expect, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import * as Core from '../core.ts'
import { route as promiseRoute } from '../examples/main.ts'
import { route as effectRoute } from '../examples/effect.ts'
import { streamRun } from '../main.ts'
import { consume, context, shop } from './fixtures/host.ts'

const decodePage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      messages: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.String })),
      next: Schema.optionalKey(Schema.String),
    }),
  ),
)
const missingConversation = Schema.decodeUnknownSync(
  Core.ConversationMissing.fields.conversationId,
)(999999)

/** Both checked server examples expose actual paging and translate their typed admission failures. */
it.live(
  'both server examples page query parameters and map invalid, stale and missing requests',
  () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => shop())
      const opened = yield* Effect.promise(() => fixture.open())
      opened.faux.setResponses([fauxAssistantMessage('Done.')])
      const stream = yield* Effect.promise(() =>
        streamRun(
          opened.harness,
          { conversationId: opened.root.id, content: 'Go', requestId: 'routes' },
          context,
        ),
      )
      yield* Effect.promise(() => consume(stream))
      const firstRequest = new Request('http://durable.test/history?limit=1')
      const first = yield* Effect.all([
        Effect.promise(() =>
          promiseRoute(opened.harness, opened.root.id, firstRequest.clone(), context),
        ),
        effectRoute(opened.harness, opened.root.id, firstRequest.clone(), context),
      ])
      for (const response of first) {
        expect(response.status).toBe(200)
        const page = yield* decodePage(yield* Effect.promise(() => response.text()))
        expect(page.messages.map((message) => message.role)).toEqual(['assistant'])
        const cursor = Option.getOrThrow(Option.fromNullishOr(page.next))
        const request = new Request(
          `http://durable.test/history?limit=1&before=${encodeURIComponent(cursor)}`,
        )
        const responses = yield* Effect.all([
          Effect.promise(() =>
            promiseRoute(opened.harness, opened.root.id, request.clone(), context),
          ),
          effectRoute(opened.harness, opened.root.id, request.clone(), context),
        ])
        for (const older of responses) {
          const previous = yield* decodePage(yield* Effect.promise(() => older.text()))
          expect(previous.messages.map((message) => message.role)).toEqual(['user'])
          expect(previous.next).toBeUndefined()
        }
      }
      const invalid = [
        new Request('http://durable.test/history?limit=0'),
        new Request('http://durable.test/history?limit=garbage'),
        new Request('http://durable.test/history?before=garbage'),
        new Request('http://durable.test/decide', {
          method: 'POST',
          body: '{"holdId":"bad","approved":true}',
        }),
      ]
      for (const request of invalid) {
        expect(
          (yield* Effect.promise(() =>
            promiseRoute(opened.harness, opened.root.id, request.clone(), context),
          )).status,
        ).toBe(400)
        expect(
          (yield* effectRoute(opened.harness, opened.root.id, request.clone(), context)).status,
        ).toBe(400)
      }
      const stale = new Request('http://durable.test/decide', {
        method: 'POST',
        body: '{"holdId":"hold:999999","approved":true}',
      })
      expect(
        (yield* Effect.promise(() =>
          promiseRoute(opened.harness, opened.root.id, stale.clone(), context),
        )).status,
      ).toBe(409)
      expect(
        (yield* effectRoute(opened.harness, opened.root.id, stale.clone(), context)).status,
      ).toBe(409)
      const request = new Request('http://durable.test/history?limit=1')
      expect(
        (yield* Effect.promise(() =>
          promiseRoute(opened.harness, missingConversation, request.clone(), context),
        )).status,
      ).toBe(404)
      expect(
        (yield* effectRoute(opened.harness, missingConversation, request.clone(), context)).status,
      ).toBe(404)
    }),
)
