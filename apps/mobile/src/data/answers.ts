import { VividRpcClient } from '@vivid/client-runtime'
import { PushAnswer, PushPayload, type DecideApprovalRequest } from '@vivid/contracts'
import { responding } from '@vivid/state'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { fetch as expoFetch } from 'expo/fetch'
import * as Notifications from 'expo-notifications'
import { start } from './app'
import { door } from './door'
import { sessionAtom } from './held'
import { rpcAddress } from './server'
import { Session, type SignedIn } from './session'
import { bearer } from './transport'

/**
 * Answering an Approval from its notification's buttons, on a phone, without the app on screen.
 * The buttons are registered with the notification categories (`notifying.ts`); the server names
 * the category in the push (`apps/server/src/push/adapter.ts`).
 *
 * The answer is the same `DecideApproval` the Feed and Notifications send, quoting the digest the
 * push carried, so the server's digest and staleness checks stand behind it. It goes over one
 * HTTP request to `/api/rpc` with the session this phone keeps, not over the live socket: the app
 * may have been started in the background for this one press, with no signed-in screen and no
 * socket. A refusal is never silent: the server's answer becomes a notification of its own, in
 * the Person's words (`responding.refusalWords`).
 *
 * What the operating system does with a press while Vivid is not running is in the category's
 * options (`notifying.ts`): on iOS a background press starts the app in the background and hands
 * the press over as the last response, which `listenForAnswers` reads at launch.
 */

const decodeAnswer = Schema.decodeUnknownOption(PushAnswer)
const decodePayload = Schema.decodeUnknownOption(PushPayload)
const encodePayload = Schema.encodeUnknownEffect(PushPayload)

/** A button press that decides, with the notice it was pressed on. */
interface Pressed {
  readonly key: string
  readonly notification: string
  readonly payload: PushPayload
  readonly request: DecideApprovalRequest
}

/** The decision a press sends; none for a tap on the notification itself or on Review. */
const pressedOf = (response: Notifications.NotificationResponse): Option.Option<Pressed> => {
  const notification = response.notification.request.identifier
  return Option.flatMap(decodeAnswer(response.actionIdentifier), (answer) =>
    Option.flatMap(decodePayload(response.notification.request.content.data), (payload) =>
      Option.map(responding.requestOf(payload.asks, answer), (request) => ({
        key: `${notification}:${answer}`,
        notification,
        payload,
        request,
      })),
    ),
  )
}

/**
 * The phone's own requests leave through Expo's fetch, without cookies (`transport.ts`), with the
 * session's token as the only authority. Expo's fetch reads a streamed body, which the RPC's
 * framed answer needs (`RpcClient.makeProtocolHttp`). Effect hands it the request's address and
 * options (`FetchHttpClient`), never a `Request`.
 */
const viaExpo: typeof globalThis.fetch = (input, init) =>
  expoFetch(input instanceof Request ? input.url : input, { ...init, credentials: 'omit' })

/** One request's client, signed in as the session this phone keeps. */
const clientFor = (session: SignedIn) =>
  VividRpcClient.layer({ url: rpcAddress(session.server), headers: bearer(session.token) }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, viaExpo)),
  )

/** One decision over `clientFor`, this press's own entry to the server. */
const sendAs = (session: SignedIn, request: DecideApprovalRequest) =>
  // @effect-diagnostics-next-line strictEffectProvide:off -- a press answered while the app may have no signed-in screen or socket gets its own one-shot HTTP client, for this one call and the whole of its lifetime
  Effect.provide(
    VividRpcClient.use((client) => client.DecideApproval(request)),
    clientFor(session),
  )

/**
 * Sends one decision. A phone with no session it can read (signed out, or a store the operating
 * system keeps locked until the phone is unlocked) cannot answer, and says so as `Failed`.
 */
const decide = Effect.fn('Answers.decide')(function* (request: DecideApprovalRequest) {
  const session = yield* AtomRegistry.getResult(door, sessionAtom)
  if (!Session.$is('SignedIn')(session)) return Option.some<responding.Refusal>('Failed')
  const result = yield* Effect.result(sendAs(session, request))
  return Result.isSuccess(result)
    ? Option.none<responding.Refusal>()
    : Option.some(responding.refusalOf(result.failure))
})

/**
 * Tells the Person their press did not go through: the action's own words as the title, the
 * server's answer as the body. Pressing it opens where the notice opens, with no buttons, since
 * the Approval it was about cannot be answered from here any more.
 */
const tell = Effect.fn('Answers.tell')(function* (
  payload: PushPayload,
  refusal: responding.Refusal,
) {
  const data = yield* encodePayload(responding.answeredOf(payload))
  yield* Effect.tryPromise(() =>
    Notifications.scheduleNotificationAsync({
      content: { title: payload.body, body: responding.refusalWords[refusal], data },
      trigger: null,
    }),
  )
})

/**
 * Answers one press. The pressed notification is taken away whatever the answer: on success it
 * is done with, and a refusal arrives as a notification of its own.
 */
const answer = Effect.fn('Answers.answer')(function* (pressed: Pressed) {
  const refused = yield* decide(pressed.request)
  yield* Effect.tryPromise(() => Notifications.dismissNotificationAsync(pressed.notification))
  if (Option.isSome(refused)) yield* tell(pressed.payload, refused.value)
})

/**
 * Hears every button press for the life of the app, from its first moment. A press that started
 * the app is the last response, read once here; later ones arrive on the listener. The same press
 * can reach both, so each is answered once: a second `DecideApproval` would be refused as already
 * answered and tell the Person so, wrongly.
 */
export const listenForAnswers = (): void => {
  const answered = new Set<string>()
  const hear = (response: Notifications.NotificationResponse) =>
    Option.map(pressedOf(response), (pressed) => {
      if (answered.has(pressed.key)) return
      answered.add(pressed.key)
      void start(
        answer(pressed).pipe(
          Effect.catch(() => Effect.logWarning('A notification answer could not be completed')),
        ),
      )
    })
  Option.map(Option.fromNullOr(Notifications.getLastNotificationResponse()), hear)
  Notifications.addNotificationResponseReceivedListener(hear)
}
