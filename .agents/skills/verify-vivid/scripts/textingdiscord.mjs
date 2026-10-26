import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import { Option, Schema } from 'effect'
import { ChannelStanding } from '@vivid/contracts'
import { decodeText } from './receipts.mjs'
import { observe } from './observation.mjs'
import { decode, history, rpc, settled, json } from './wire.mjs'
import { redact } from './discord.mjs'

const settings = [
  'VIVID_VERIFY_DISCORD_TOKEN_FILE',
  'VIVID_VERIFY_DISCORD_USER_TOKEN_FILE',
  'VIVID_VERIFY_DISCORD_CHANNEL',
]
const User = Schema.Struct({ id: Schema.String })
const Channel = Schema.Struct({ id: Schema.String })
/** Decoding keeps only these fields, so evidence never holds the tester's profile. */
const Message = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  content: Schema.String,
  author: User,
  mention_everyone: Schema.Boolean,
  mention_roles: Schema.Array(Schema.String),
  message_reference: Schema.optionalKey(
    Schema.Struct({ message_id: Schema.optionalKey(Schema.String) }),
  ),
})
const Messages = Schema.Array(Message)
const gatewayMessage = Schema.decodeUnknownOption(Message)
const Packet = Schema.Struct({
  op: Schema.Number,
  t: Schema.optionalKey(Schema.NullOr(Schema.String)),
  s: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  d: Schema.Unknown,
})
const Hello = Schema.Struct({ heartbeat_interval: Schema.Number })

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'
/** GUILDS, GUILD_MESSAGES and DIRECT_MESSAGES. A bot receives its own messages under these
 * without the privileged MESSAGE_CONTENT intent. */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12)
const DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

/** One Discord REST exchange or gateway handshake. Discord can hold a socket open with no reply
 * and nothing else cancels this fixture call. 30 s matches DISCORD_TIMEOUT in discord.mjs; on
 * expiry the feature fails, never passes. */
const DISCORD_TIMEOUT = 30_000

/** Bounds the gap between the server's own signal (Connected, or a settled Run) and the bot's
 * message reaching the gateway. The server sends after that signal and gives up a chunk after
 * 30 s (CHUNK_ACCEPTANCE_LIMIT in apps/server/src/channels/replies.ts); 60 s is twice that. On
 * expiry the feature fails. */
const REPLY_AFTER_SIGNAL = 60_000

/** The bot and the tester account are external authorities. Without them the recipe is blocked. */
export function textingDiscordBlocked() {
  const missing = settings.filter((name) => !process.env[name])
  return missing.length === 0
    ? {}
    : {
        'texting-discord':
          'blocked: needs Discord bot and tester account. Set ' + missing.join(', '),
      }
}

const repliesTo = (message) =>
  message.message_reference === undefined ? undefined : message.message_reference.message_id

/** Each token stays in its closure. Evidence records method, path, status and the decoded answer;
 * the Authorization header is never written anywhere. */
const discordApi =
  ({ base, headers }, directory) =>
  async ({ method = 'GET', path, body, schema, name }) => {
    const init = { method, headers, signal: AbortSignal.timeout(DISCORD_TIMEOUT) }
    if (body !== undefined) {
      init.headers = { ...headers, 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await fetch(base + path, init)
    const text = await response.text()
    if (!response.ok) {
      await json(directory + '/' + name + '.json', { method, path, status: response.status, text })
      throw new Error(`Discord ${method} ${path}: ${response.status} ${text}`)
    }
    const value = schema === undefined ? null : decodeText(schema, text)
    await json(directory + '/' + name + '.json', { method, path, status: response.status, value })
    return value
  }

/** A second gateway session for the bot, open before the tester sends anything. Discord pushes the
 * bot's own MESSAGE_CREATE to it, so each reply is awaited on Discord's delivery, not polled. */
async function gateway(token) {
  const socket = new WebSocket(GATEWAY)
  const seen = []
  const waiters = new Set()
  const ready = Promise.withResolvers()
  let failure
  let heartbeat
  let sequence = null
  const fail = (error) => {
    failure ??= error
    ready.reject(failure)
    for (const waiter of waiters) waiter.reject(failure)
    waiters.clear()
  }
  const deliver = (message) => {
    seen.push(message)
    for (const waiter of waiters)
      if (waiter.accept(message)) {
        waiters.delete(waiter)
        waiter.resolve(message)
      }
  }
  const identify = (hello) => {
    // Discord sets the heartbeat cadence in HELLO; missing it closes the session.
    heartbeat = setInterval(
      () => socket.send(JSON.stringify({ op: 1, d: sequence })),
      decode(Hello, hello).heartbeat_interval,
    )
    const properties = { os: 'linux', browser: 'vivid-verify', device: 'vivid-verify' }
    socket.send(JSON.stringify({ op: 2, d: { token, intents: INTENTS, properties } }))
  }
  const receive = (data) => {
    const packet = decodeText(Packet, data)
    if (packet.s !== undefined && packet.s !== null) sequence = packet.s
    if (packet.op === 10) identify(packet.d)
    else if (packet.op === 7 || packet.op === 9)
      fail(new Error('Discord gateway dropped the session (op ' + packet.op + ')'))
    else if (packet.t === 'READY') ready.resolve()
    else if (packet.t === 'MESSAGE_CREATE')
      // Other members' messages in the server may lack fields; only well-formed ones are kept.
      Option.map(gatewayMessage(packet.d), deliver)
  }
  // A throw inside a WebSocket listener would crash the process; it fails the observer instead.
  socket.addEventListener('message', ({ data }) => {
    try {
      receive(data)
    } catch (error) {
      fail(error)
    }
  })
  socket.addEventListener('close', ({ code }) => fail(new Error('Discord gateway closed ' + code)))
  socket.addEventListener('error', () => fail(new Error('Discord gateway failed')))
  const close = () => {
    clearInterval(heartbeat)
    socket.close(1000)
  }
  const handshake = setTimeout(
    () => fail(new Error('Discord gateway READY deadline')),
    DISCORD_TIMEOUT,
  )
  try {
    await ready.promise
  } catch (error) {
    close()
    throw error
  } finally {
    clearTimeout(handshake)
  }
  /** The first bot message in `channel` that replies to `source`. Called after the server's own
   * signal, so the bound covers only the send. */
  const reply = async (channel, source, botId) => {
    const accept = (message) =>
      message.author.id === botId && message.channel_id === channel && repliesTo(message) === source
    const found = seen.find(accept)
    if (found) return found
    if (failure) throw failure
    const waiter = { accept, ...Promise.withResolvers() }
    waiters.add(waiter)
    const deadline = setTimeout(() => {
      waiters.delete(waiter)
      waiter.reject(new Error('No bot reply to ' + source + ' reached the gateway'))
    }, REPLY_AFTER_SIGNAL)
    try {
      return await waiter.promise
    } finally {
      clearTimeout(deadline)
    }
  }
  return { reply, seen, close }
}

const discordOf = ({ channels }) => channels.find((link) => link.channel === 'Discord').standing

/** The public live stream the Text Vivid screen reads. */
async function discordStanding(state, accept, directory, name) {
  const published = await observe(state, {
    tag: 'WatchChannels',
    payload: null,
    accept: (candidate) => accept(discordOf(candidate)),
  })
  await json(directory + '/' + name + '.json', published)
  return discordOf(published)
}

/** The bot's own read of a message it posted: the independent Discord-side receipt. */
async function botRead(journey, message, name) {
  const read = await journey.bot({
    path: `/channels/${message.channel_id}/messages/${message.id}`,
    schema: Message,
    name,
  })
  NodeAssert.equal(read.id, message.id)
  NodeAssert.equal(read.author.id, journey.botId)
  return read
}

/** The tester's message, remembered for cleanup before anything can fail. */
async function say(journey, place, content, name) {
  const message = await journey.tester({
    method: 'POST',
    path: `/channels/${place}/messages`,
    body: { content },
    schema: Message,
    name,
  })
  journey.cleanup.tester.push({ channel: place, id: message.id })
  return message
}

const userWords = (page) =>
  page.messages
    .filter((message) => message.role === 'user')
    .map((message) =>
      message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' '),
    )

/** Text Vivid's Connect: the code goes from the tester's DM to the bot, as the screen tells them. */
async function connect(state, journey, directory) {
  const before = await discordStanding(state, () => true, directory, 'channels-before')
  NodeAssert.ok(
    ChannelStanding.guards.NotConnected(before),
    'Discord stands ' + before._tag + '; launch with VIVID_VERIFY_DISCORD_TOKEN_FILE set',
  )
  const { link: awaiting } = await rpc(state, 'ConnectChannel', { channel: 'Discord' }, directory)
  NodeAssert.ok(ChannelStanding.guards.Awaiting(awaiting.standing), 'Connect did not await a code')
  NodeAssert.equal(awaiting.standing.textTo, 'discord:' + journey.botId)
  NodeAssert.match(awaiting.standing.code, /^[0-9]{6}$/)
  const dm = await journey.tester({
    method: 'POST',
    path: '/users/@me/channels',
    body: { recipients: [journey.botId] },
    schema: Channel,
    name: 'tester-dm',
  })
  const code = await say(journey, dm.id, awaiting.standing.code, 'tester-code')
  const connected = await discordStanding(
    state,
    ChannelStanding.guards.Connected,
    directory,
    'channels-connected',
  )
  NodeAssert.equal(connected.address, 'discord:' + journey.testerId)
  NodeAssert.equal(connected.textTo, 'discord:' + journey.botId)
  const confirmation = await botRead(
    journey,
    await journey.observer.reply(dm.id, code.id, journey.botId),
    'bot-confirmation',
  )
  NodeAssert.match(confirmation.content, /^Connected\./)
  return { dm: dm.id, code: code.id, confirmation: confirmation.id }
}

/** A DM opens the linked Person's private Thread; the bot answers in the DM, replying to it. */
async function direct(state, journey, dm, directory) {
  const { threads: known } = await rpc(state, 'ListThreads', undefined, directory)
  const isNew = (thread) => !known.some((prior) => prior.id === thread.id)
  const pineapple = await say(
    journey,
    dm,
    'Reply with exactly the word pineapple and nothing else.',
    'tester-dm-pineapple',
  )
  const { threads } = await observe(state, {
    tag: 'WatchThreads',
    payload: null,
    accept: (published) => published.threads.some(isNew),
  })
  const thread = threads.find(isNew).id
  await settled(state, thread, 1, 'Completed', directory)
  const reply = await botRead(
    journey,
    await journey.observer.reply(dm, pineapple.id, journey.botId),
    'bot-dm-reply',
  )
  NodeAssert.match(reply.content, /pineapple/i)
  return { thread, pineapple: { message: pineapple.id, reply: reply.id } }
}

/** A mention in the server channel continues the same Thread; plain channel text is ignored. */
async function mention(state, journey, { channel, thread, nonce }, directory) {
  // Sent before the mention: the worker takes channel text in order, so once the mention is
  // answered this message has been seen and dropped, and its absence needs no wait.
  const unmentioned = await say(
    journey,
    channel,
    'No mention here, ' + nonce + '. Reply with exactly the word kiwi.',
    'tester-channel-unmentioned',
  )
  const mango = await say(
    journey,
    channel,
    `<@${journey.botId}> Reply with exactly the word mango.`,
    'tester-channel-mango',
  )
  await settled(state, thread, 2, 'Completed', directory)
  const reply = await botRead(
    journey,
    await journey.observer.reply(channel, mango.id, journey.botId),
    'bot-channel-reply',
  )
  NodeAssert.match(reply.content, /mango/i)
  NodeAssert.equal(reply.mention_everyone, false, 'Reply pinged everyone')
  NodeAssert.deepEqual(reply.mention_roles, [], 'Reply pinged a role')

  const after = await journey.bot({
    path: `/channels/${channel}/messages?after=${unmentioned.id}&limit=50`,
    schema: Messages,
    name: 'channel-after-unmentioned',
  })
  const answered = (message) => repliesTo(message) === unmentioned.id
  NodeAssert.ok(!after.some(answered), 'Vivid answered a message without a mention')
  NodeAssert.ok(!journey.observer.seen.some(answered), 'Vivid answered a message without a mention')
  const detail = await rpc(state, 'GetThread', { id: thread }, directory, 'thread')
  NodeAssert.equal(detail.runs.length, 2, 'Channel text started other Runs')
  const said = userWords(await history(state, thread, directory, 'channel-history'))
  NodeAssert.equal(said.length, 2)
  NodeAssert.match(said[0], /pineapple/)
  NodeAssert.match(said[1], /mango/)
  NodeAssert.ok(!said.join(' ').includes(nonce), 'Unmentioned text reached the Thread')
  return { message: mango.id, reply: reply.id, unmentioned: unmentioned.id }
}

/** Every step runs and records its own failure, so one failed step never strands the others. */
async function cleanUp(state, journey, directory) {
  const { cleanup } = journey
  const attempt = (step, work) =>
    work().catch((error) => {
      cleanup.errors.push(step + ': ' + error.message)
    })
  await attempt('DisconnectChannel', async () => {
    const { link: left } = await rpc(state, 'DisconnectChannel', { channel: 'Discord' }, directory)
    NodeAssert.ok(ChannelStanding.guards.NotConnected(left.standing), 'Disconnect left a link')
    const standing = await discordStanding(
      state,
      ChannelStanding.guards.NotConnected,
      directory,
      'channels-disconnected',
    )
    cleanup.standing = standing._tag
  })
  for (const message of cleanup.tester)
    await attempt('delete tester ' + message.id, async () => {
      await journey.tester({
        method: 'DELETE',
        path: `/channels/${message.channel}/messages/${message.id}`,
        name: 'cleanup-tester-' + message.id,
      })
      cleanup.deleted.push(message.id)
    })
  const sources = new Set(cleanup.tester.map((message) => message.id))
  const replies =
    journey.observer === undefined
      ? []
      : journey.observer.seen.filter(
          (message) => message.author.id === journey.botId && sources.has(repliesTo(message)),
        )
  for (const message of replies)
    await attempt('delete bot ' + message.id, async () => {
      await journey.bot({
        method: 'DELETE',
        path: `/channels/${message.channel_id}/messages/${message.id}`,
        name: 'cleanup-bot-' + message.id,
      })
      cleanup.deleted.push(message.id)
    })
  if (journey.observer !== undefined) journey.observer.close()
  await json(directory + '/cleanup.json', cleanup)
}

/** Connect Discord in Text Vivid with a code from the tester's DM, then talk to Vivid by DM and by
 * @mention as that tester. The Thread drive.mjs made is personal and unused; channel text opens
 * its own. */
export async function textingDiscordProof(state, _personal, directory) {
  NodeAssert.equal(state.modelKind, 'real', 'Texting Vivid on Discord needs a real model')
  const [botFile, userFile, channel] = settings.map((name) => process.env[name])
  NodeAssert.match(channel, /^[0-9]+$/, 'VIVID_VERIFY_DISCORD_CHANNEL is not a snowflake')
  const botToken = (await NodeFSP.readFile(botFile, 'utf8')).trim()
  const userToken = (await NodeFSP.readFile(userFile, 'utf8')).trim()
  NodeAssert.ok(botToken.length > 0, 'VIVID_VERIFY_DISCORD_TOKEN_FILE is empty')
  NodeAssert.ok(userToken.length > 0, 'VIVID_VERIFY_DISCORD_USER_TOKEN_FILE is empty')
  const nonce = 'vivid-verify-' + crypto.randomUUID()
  const journey = {
    bot: discordApi(
      { base: 'https://discord.com/api/v10', headers: { authorization: 'Bot ' + botToken } },
      directory,
    ),
    tester: discordApi(
      {
        base: 'https://discord.com/api/v9',
        headers: { authorization: userToken, 'user-agent': DESKTOP },
      },
      directory,
    ),
    botId: undefined,
    testerId: undefined,
    observer: undefined,
    cleanup: { nonce, tester: [], deleted: [], standing: null, errors: [] },
  }
  let failure
  try {
    journey.botId = (
      await journey.bot({ path: '/users/@me', schema: User, name: 'discord-bot' })
    ).id
    journey.testerId = (
      await journey.tester({ path: '/users/@me', schema: User, name: 'discord-tester' })
    ).id
    journey.observer = await gateway(botToken)
    const linked = await connect(state, journey, directory)
    const dm = await direct(state, journey, linked.dm, directory)
    const mango = await mention(state, journey, { channel, thread: dm.thread, nonce }, directory)
    await json(directory + '/proof.json', {
      bot: journey.botId,
      tester: journey.testerId,
      channel,
      ...linked,
      ...dm,
      mango,
    })
  } catch (error) {
    failure = error
  }
  await cleanUp(state, journey, directory)
  await redact(state.evidence, [botToken, userToken], directory)
  if (failure) throw failure
  NodeAssert.deepEqual(journey.cleanup.errors, [], 'Discord cleanup failed')
}
