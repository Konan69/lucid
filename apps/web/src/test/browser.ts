import { Option, Schema } from 'effect'
import { vi } from 'vitest'

/**
 * The browser a page of the web app runs in, for a test that drives the app's own modules.
 *
 * The data modules are the page: `data/runtime.ts` opens the one socket, `data/drafts.ts` holds
 * this tab's drafts, `data/threads.ts` sends a Thread's first words. They take nothing as an
 * argument; what they stand on is the browser. So a test replaces the browser and nothing of
 * ours: the store (`localStorage`), the events a page is told of, the address, the socket's
 * other end (`WebSocket`) and the network (`fetch`). Every module in between is the real one,
 * the live engine and its RPC client included.
 *
 * `open` must be called before the first module of the app is imported: they read the address
 * and the store as they load.
 *
 * The socket's other end speaks what `VividRpcClient.layerLive` speaks (`packages/client/rpc`
 * `rpc.ts`): Effect's RPC socket protocol with JSON serialization, one JSON message per frame
 * (effect 4.0.0-rc.116 `unstable/rpc/RpcClient.ts` `makeProtocolSocket`, `RpcSerialization.ts`
 * `json`, `RpcMessage.ts` `RequestEncoded`, `ResponseChunkEncoded`, `ResponseExitEncoded`). A
 * test gives it values already encoded by the contract's own schema, so what the page decodes
 * is what the server would have sent.
 */

/** A value on the wire: what a contract schema encodes to, on its way through `JSON`. */
type Wire = Schema.Json

const asWire = Schema.decodeUnknownSync(Schema.Json)

/**
 * A contract value as the server puts it on the wire: encoded by the contract's own schema. A
 * test builds what the server answers out of the same types the server does, and this is the
 * one way such a value reaches the socket.
 */
export const wire = <Value, Encoded>(schema: Schema.Codec<Value, Encoded>, value: Value): Wire =>
  asWire(Schema.encodeSync(schema)(value))

const RequestId = Schema.Union([Schema.String, Schema.Finite])

/**
 * A frame the page sends on its socket, as far as the other end reads it: a request is answered,
 * a ping is answered, and the rest (an acknowledged chunk, a watch let go) need nothing here.
 */
const Sent = Schema.TaggedUnion({
  Request: { id: RequestId, tag: Schema.String, payload: Schema.optionalKey(Schema.Json) },
  Ping: {},
  Ack: {},
  Interrupt: {},
  Eof: {},
})
const readSent = Schema.decodeUnknownSync(Schema.fromJsonString(Sent))

/** How a call ended, as the server says it. Every call here succeeds. */
const Ended = Schema.TaggedStruct('Success', { value: Schema.Json })

/** A frame the server sends: an answer to a ping, a watched query's value, a call's ending. */
const Answered = Schema.TaggedUnion({
  Pong: {},
  Chunk: { requestId: RequestId, values: Schema.Tuple([Schema.Json]) },
  Exit: { requestId: RequestId, exit: Ended },
})
type Answered = typeof Answered.Type
const writeAnswered = Schema.encodeSync(Schema.fromJsonString(Answered))

/**
 * One message as the conversation client posts it (`@flue/sdk` 2.2.2 `sendConversationMessage`:
 * `POST <conversation url>`, the message's own fields beside `idempotencyKey` when one is given).
 */
const Posted = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literal('user'),
    body: Schema.String,
    idempotencyKey: Schema.optionalKey(Schema.String),
  }),
)
export interface Posted extends Schema.Schema.Type<typeof Posted> {}
const readPosted = Schema.decodeUnknownSync(Posted)

/** What a listener is told. Each kind of event carries the few fields its listeners read. */
interface Told {
  readonly key?: string
  readonly data?: string
  readonly code?: number
  readonly reason?: string
}
type Listener = (event: Told) => void

/** The listeners of one event target, by event name. */
const makeTarget = () => {
  const heard = new Map<string, ReadonlyArray<Listener>>()
  const listening = (type: string) => heard.get(type) ?? []
  return {
    addEventListener: (type: string, listener: Listener) => {
      heard.set(type, [...listening(type), listener])
    },
    removeEventListener: (type: string, listener: Listener) => {
      heard.set(
        type,
        listening(type).filter((one) => one !== listener),
      )
    },
    tell: (type: string, event: Told) => {
      for (const listener of listening(type)) listener(event)
    },
  }
}
type Target = ReturnType<typeof makeTarget>

/**
 * The browser's store. A test reads and writes it as another tab would, uncounted; what the page
 * itself reads and writes is counted by name.
 */
const makeStore = (page: Target) => {
  const held = new Map<string, string>()
  const counts = { reads: new Map<string, number>(), writes: new Map<string, number>() }
  const count = (of: Map<string, number>, name: string) => of.set(name, (of.get(name) ?? 0) + 1)
  const store = {
    /** A store that is full answers reads and refuses every write, as a browser's does. */
    full: false,
    /** What is kept under a name. Not counted: it is the test looking, not the page. */
    read: (name: string) => Option.fromUndefinedOr(held.get(name)),
    /** What another tab of this browser writes, and the event this tab is told of it by. */
    writtenElsewhere: (name: string, value: string) => {
      held.set(name, value)
      page.tell('storage', { key: name })
    },
    /** The same write before this tab has been told of it. */
    writtenUnheard: (name: string, value: string) => {
      held.set(name, value)
    },
    reads: (name: string) => counts.reads.get(name) ?? 0,
    writes: (name: string) => counts.writes.get(name) ?? 0,
  }
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => {
      count(counts.reads, name)
      return held.get(name) ?? null
    },
    setItem: (name: string, value: string) => {
      count(counts.writes, name)
      if (store.full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      held.set(name, value)
    },
    removeItem: (name: string) => {
      held.delete(name)
    },
  })
  return store
}

/** The page itself: its address, its history, and the things modules ask of it as they load. */
const makePage = (page: Target) => {
  const address = { now: new URL('https://vivid.test/') }
  vi.stubGlobal('location', {
    get protocol() {
      return address.now.protocol
    },
    get host() {
      return address.now.host
    },
    get origin() {
      return address.now.origin
    },
    get pathname() {
      return address.now.pathname
    },
    get search() {
      return address.now.search
    },
    get href() {
      return address.now.href
    },
  })
  const go = (_state: null, _title: string, path: string) => {
    address.now = new URL(path, address.now)
  }
  vi.stubGlobal('history', { pushState: go, replaceState: go })
  // The page and its document share one list of listeners; no test tells them apart.
  vi.stubGlobal('addEventListener', page.addEventListener)
  vi.stubGlobal('window', { addEventListener: page.addEventListener })
  vi.stubGlobal('document', {
    addEventListener: page.addEventListener,
    hidden: false,
    documentElement: { dataset: {} },
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, ...makeTarget() }))
}

/** A request the page made: how to answer it, and what it carried. */
interface Asked {
  readonly reply: (frame: Answered) => void
  readonly id: typeof RequestId.Type
  readonly payload: Wire
}

/**
 * The socket's other end. A request whose name starts with `Watch` is a live query: it is told
 * what the query last said, and again each time the test says something new. Any other request
 * is a call, answered once, as soon as the test has said how that kind of call is answered.
 */
const makeServer = () => {
  const answers = new Map<string, (payload: Wire) => Wire>()
  const said = new Map<string, Wire>()
  const waiting = new Map<string, ReadonlyArray<Asked>>()
  const watching = new Map<string, ReadonlyArray<Asked>>()
  const asked = new Map<string, ReadonlyArray<Wire>>()
  const tells = (to: Asked, value: Wire) =>
    to.reply(Answered.cases.Chunk.make({ requestId: to.id, values: [value] }))

  /** Answers every call of one kind that is waiting, if the test has said how. */
  const settle = (tag: string) => {
    const answer = answers.get(tag)
    if (answer === undefined) return
    for (const call of waiting.get(tag) ?? []) {
      call.reply(
        Answered.cases.Exit.make({
          requestId: call.id,
          exit: Ended.make({ value: answer(call.payload) }),
        }),
      )
    }
    waiting.delete(tag)
  }

  /** One request from the page: remembered, then answered as a watch or as a call. */
  const hear = (tag: string, request: Asked) => {
    asked.set(tag, [...(asked.get(tag) ?? []), request.payload])
    if (!tag.startsWith('Watch')) {
      waiting.set(tag, [...(waiting.get(tag) ?? []), request])
      settle(tag)
      return
    }
    watching.set(tag, [...(watching.get(tag) ?? []), request])
    Option.map(Option.fromUndefinedOr(said.get(tag)), (last) => tells(request, last))
  }

  /**
   * The browser's `WebSocket`, as far as Effect's socket uses one (`unstable/socket/Socket.ts`
   * `fromWebSocket`): it opens a moment after it is made, takes frames, and is told frames.
   */
  class Socket {
    readyState = 0
    readonly #target = makeTarget()
    readonly addEventListener = this.#target.addEventListener
    readonly removeEventListener = this.#target.removeEventListener

    constructor() {
      queueMicrotask(() => {
        this.readyState = 1
        this.#target.tell('open', {})
      })
    }

    send(data: string) {
      const reply = (frame: Answered) =>
        this.#target.tell('message', { data: writeAnswered(frame) })
      Sent.match(readSent(data), {
        Request: ({ id, tag, payload = null }) => hear(tag, { reply, id, payload }),
        Ping: () => reply(Answered.cases.Pong.make({})),
        Ack: () => undefined,
        Interrupt: () => undefined,
        Eof: () => undefined,
      })
    }

    close(code = 1000) {
      this.readyState = 3
      this.#target.tell('close', { code, reason: '' })
    }
  }
  vi.stubGlobal('WebSocket', Socket)

  return {
    /** How the server answers a kind of call from now on, and every one already waiting. */
    answers: (tag: string, answer: (payload: Wire) => Wire) => {
      answers.set(tag, answer)
      settle(tag)
    },
    /** What a watched query now says, to everyone watching it and everyone who starts to. */
    says: (tag: string, value: Wire) => {
      said.set(tag, value)
      for (const watch of watching.get(tag) ?? []) tells(watch, value)
    },
    /** The payload of every request of one kind the page has made, in order. */
    asked: (tag: string): ReadonlyArray<Wire> => asked.get(tag) ?? [],
  }
}

/** The network a conversation's messages are posted over. */
const makeNetwork = () => {
  const posts: Array<Posted> = []
  const network = {
    /** Whether an answer makes it back. When not, the server still took what was posted. */
    arrives: true,
    /** Every message posted to a conversation, in order, whether or not its answer came back. */
    posts: (): ReadonlyArray<Posted> => posts,
  }
  vi.stubGlobal('fetch', (url: string, init: { readonly body: string }) => {
    posts.push(readPosted(init.body))
    return network.arrives
      ? Promise.resolve(
          Response.json(
            { submissionId: 'submission', streamUrl: url, offset: '0' },
            { status: 202 },
          ),
        )
      : Promise.reject(new TypeError('Failed to fetch'))
  })
  return network
}

/** Puts the browser in place. Call it before the first module of the app is imported. */
export function open() {
  const page = makeTarget()
  makePage(page)
  return {
    store: makeStore(page),
    server: makeServer(),
    network: makeNetwork(),
    /** Something the page is told of: it is being left, or hidden. */
    happens: (type: 'pagehide' | 'visibilitychange') => page.tell(type, {}),
  }
}
