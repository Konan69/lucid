import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import * as NodeAssert from 'node:assert/strict'
import { Redacted, Schema } from 'effect'
import {
  ActionTarget,
  ApprovalDecision,
  ApprovalState,
  ConnectionState,
  ConnectionStep,
  ShareThreadRequest,
  SwitchWorkspaceRequest,
  Workspace,
} from '@vivid/contracts'
import { decodeText } from './receipts.mjs'
import { chat, history, rpc, settled, json } from './wire.mjs'
import { catalog } from './settingsproof.mjs'

const settings = [
  'VIVID_VERIFY_DISCORD_TOKEN_FILE',
  'VIVID_VERIFY_DISCORD_GUILD',
  'VIVID_VERIFY_DISCORD_CHANNEL',
]
const service = 'vivid/discord'
const User = Schema.Struct({ id: Schema.String })
const Channel = Schema.Struct({ id: Schema.String, guild_id: Schema.String })
const Messages = Schema.Array(
  Schema.Struct({ id: Schema.String, content: Schema.String, author: User }),
)

/** One Discord REST exchange. Discord can hold a socket open with no reply and nothing else
 * cancels this fixture read. 30 s matches the signed-delivery bound in watch.mjs; on expiry the
 * feature fails, never passes. */
const DISCORD_TIMEOUT = 30_000

/** The journey asks for one post, then one read. find_tools needs no Approval; a read before the
 * post adds one more. A fourth decision in one step means Vivid is looping, which fails the step. */
const MAX_DECISIONS = 3

/** The Discord test bot is an external authority. Without it the recipe is blocked, not run. */
export function discordBlocked() {
  const missing = settings.filter((name) => !process.env[name])
  return missing.length === 0
    ? {}
    : { discord: 'blocked: needs Discord test bot. Set ' + missing.join(', ') }
}

/** The token stays in this closure. Evidence records method, path, status and Discord's answer;
 * the Authorization header is never written anywhere. */
const discordApi =
  (token, directory) =>
  async ({ method = 'GET', path, schema, name }) => {
    const response = await fetch('https://discord.com/api/v10' + path, {
      method,
      headers: { authorization: 'Bot ' + token },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT),
    })
    const text = await response.text()
    await json(directory + '/' + name + '.json', { method, path, status: response.status, text })
    if (!response.ok) throw new Error(`Discord ${method} ${path}: ${response.status} ${text}`)
    return schema === undefined ? null : decodeText(schema, text)
  }

/** A personal Integration in a Company-shared Thread always asks, reads included (gate.ts,
 * PersonalInShared). Each Pending Approval is allowed through the DecideApproval the Allow card
 * sends, then WatchThread waits for the Decision Run it starts. Ends when nothing is Pending. */
export async function allowPending(state, id, { runs, step }, directory) {
  let detail = await settled(state, id, runs, 'Completed', directory)
  for (let decisions = 0; ; decisions++) {
    const pending = detail.approvals.find((approval) =>
      ApprovalState.guards.Pending(approval.state),
    )
    if (pending === undefined) return detail
    NodeAssert.ok(decisions < MAX_DECISIONS, 'Vivid kept raising Approvals in ' + step)
    const { approval } = await rpc(
      state,
      'DecideApproval',
      {
        id: pending.id,
        digest: pending.digest,
        decision: ApprovalDecision.cases.AllowOnce.make({}),
      },
      directory,
      step + '-allow-' + (decisions + 1),
    )
    NodeAssert.ok(
      ApprovalState.guards.Succeeded(approval.state),
      'Approved action did not succeed: ' + JSON.stringify(approval.state),
    )
    detail = await settled(state, id, detail.runs.length + 1, 'Completed', directory)
  }
}

const succeeded = (detail, connection, tool) =>
  detail.approvals.filter(
    ({ action, state }) =>
      ApprovalState.guards.Succeeded(state) &&
      ActionTarget.guards.Connection(action.target) &&
      action.target.connectionId === connection &&
      action.target.tool === tool,
  )

/** The web's Create a company dialog enters the new Company for this session. */
async function enterCompany(state, nonce, directory) {
  const company = await rpc(
    state,
    'CreateCompany',
    { name: 'Verify Discord ' + nonce.slice(-8) },
    directory,
  )
  const me = await rpc(state, 'Me', undefined, directory)
  NodeAssert.ok(Workspace.guards.Company(me.workspace), 'CreateCompany did not enter the Company')
  NodeAssert.equal(me.workspace.company.id, company.id)
  return company
}

/** The Key form's calls with "For you": Begin unshared, then Complete with the one masked field. */
async function connectDiscord(state, token, cleanup, directory) {
  const services = await catalog(state, directory, 'Discord', 'services')
  NodeAssert.ok(
    services.some((entry) => entry.id === service),
    'Discord is not in the catalog',
  )
  const begun = await rpc(
    state,
    'BeginConnection',
    { service, from: 'Web', name: null, shared: false },
    directory,
  )
  NodeAssert.ok(ConnectionStep.guards.EnterKey(begun), 'Discord did not ask for a key')
  cleanup.connection = begun.connection.id
  NodeAssert.deepEqual(
    begun.fields.map((field) => field.name),
    ['token'],
  )
  // No evidence directory: the recorded payload would carry the token.
  const completed = await rpc(state, 'CompleteConnection', {
    id: begun.connection.id,
    fields: { token: Redacted.make(token) },
  })
  await json(directory + '/connection.json', completed.connection)
  NodeAssert.ok(ConnectionState.guards.Ready(completed.connection.state), 'Discord is not Ready')
  return begun.connection.id
}

/** A Thread made inside the Company and shared with it, as the Share dialog does. */
async function companyThread(state, directory) {
  const id = crypto.randomUUID()
  await rpc(state, 'CreateThread', { id, title: 'Verify Discord', projectId: null }, directory)
  const shared = await rpc(
    state,
    'ShareThread',
    { id, audience: ShareThreadRequest.cases.Company.make({}) },
    directory,
  )
  NodeAssert.equal(shared.thread.audience._tag, 'Company')
  return id
}

/** Every step runs and records its own failure, so one failed step never strands the others. */
async function cleanUp(state, { api, channel, nonce, cleanup }, directory) {
  const attempt = (step, work) =>
    work().catch((error) => {
      cleanup.errors.push(step + ': ' + error.message)
    })
  if (cleanup.connection)
    await attempt('RemoveConnection', async () => {
      await rpc(state, 'RemoveConnection', { id: cleanup.connection }, directory)
      cleanup.removed = true
    })
  await attempt('delete nonce messages', async () => {
    const left = await api({
      path: `/channels/${channel}/messages?limit=20`,
      schema: Messages,
      name: 'cleanup-messages',
    })
    for (const message of left.filter((candidate) => candidate.content.includes(nonce))) {
      await api({
        method: 'DELETE',
        path: `/channels/${channel}/messages/${message.id}`,
        name: 'cleanup-delete-' + message.id,
      })
      cleanup.deleted.push(message.id)
    }
  })
  await attempt('SwitchWorkspace', async () => {
    const personal = await rpc(
      state,
      'SwitchWorkspace',
      { to: SwitchWorkspaceRequest.cases.Personal.make({}) },
      directory,
    )
    cleanup.workspace = personal.workspace._tag
  })
  await json(directory + '/cleanup.json', cleanup)
}

/** Any copy of a token in retained evidence is replaced and fails the feature. Private scratch
 * (instance/) is deleted by Cleanup and is not evidence. */
export async function redact(evidence, tokens, directory) {
  const found = []
  for (const entry of await NodeFSP.readdir(evidence, { recursive: true, withFileTypes: true })) {
    const file = NodePath.join(entry.parentPath, entry.name)
    if (!entry.isFile() || file.startsWith(evidence + '/instance/')) continue
    const text = await NodeFSP.readFile(file, 'utf8')
    if (!tokens.some((token) => text.includes(token))) continue
    found.push(NodePath.relative(evidence, file))
    await NodeFSP.writeFile(
      file,
      tokens.reduce((redacted, token) => redacted.replaceAll(token, '<redacted>'), text),
    )
  }
  await json(directory + '/redaction.json', { found })
  NodeAssert.deepEqual(found, [], 'A token reached evidence')
}

/** Connect Discord with a bot token, post through an Approval from a Company Thread, read Discord
 * back independently, then read through Vivid. The Thread drive.mjs made is personal and unused. */
export async function discordProof(state, _personal, directory) {
  NodeAssert.equal(state.modelKind, 'real', 'Discord needs a real model')
  const [file, guild, channel] = settings.map((name) => process.env[name])
  NodeAssert.match(guild, /^[0-9]+$/, 'VIVID_VERIFY_DISCORD_GUILD is not a snowflake')
  NodeAssert.match(channel, /^[0-9]+$/, 'VIVID_VERIFY_DISCORD_CHANNEL is not a snowflake')
  const token = (await NodeFSP.readFile(file, 'utf8')).trim()
  NodeAssert.ok(token.length > 0, 'VIVID_VERIFY_DISCORD_TOKEN_FILE is empty')
  const api = discordApi(token, directory)
  const nonce = 'vivid-verify-' + crypto.randomUUID()
  const cleanup = {
    nonce,
    connection: null,
    removed: false,
    deleted: [],
    workspace: null,
    errors: [],
  }
  let failure
  try {
    const bot = await api({ path: '/users/@me', schema: User, name: 'discord-bot' })
    const target = await api({
      path: '/channels/' + channel,
      schema: Channel,
      name: 'discord-channel',
    })
    NodeAssert.equal(target.guild_id, guild, 'Channel is not in the configured guild')
    const company = await enterCompany(state, nonce, directory)
    const connection = await connectDiscord(state, token, cleanup, directory)
    const id = await companyThread(state, directory)

    await chat(
      state,
      id,
      `Post a message to my Discord channel ${channel} in server ${guild}. The message text is exactly: ${nonce}. Use find_tools, then use_tool with my Discord account. Post it once.`,
      directory,
      'post',
    )
    const posted = await allowPending(state, id, { runs: 1, step: 'post' }, directory)
    await history(state, id, directory, 'post-history')
    NodeAssert.equal(
      succeeded(posted, connection, 'channels.createMessage').length,
      1,
      'No single approved channels.createMessage',
    )
    const recent = await api({
      path: `/channels/${channel}/messages?limit=20`,
      schema: Messages,
      name: 'discord-messages',
    })
    const matching = recent.filter((message) => message.content.includes(nonce))
    NodeAssert.equal(matching.length, 1, 'Discord does not hold exactly one nonce message')
    NodeAssert.equal(matching[0].author.id, bot.id, 'Nonce message is not authored by the bot')
    await json(directory + '/proof.json', {
      nonce,
      guild,
      channel,
      message: matching[0].id,
      author: bot.id,
      company: company.id,
      thread: id,
      connection,
    })

    await chat(
      state,
      id,
      `Read the latest messages in my Discord channel ${channel} with my Discord account and summarize them in two sentences. Do not post anything.`,
      directory,
      'read',
    )
    const read = await allowPending(
      state,
      id,
      { runs: posted.runs.length + 1, step: 'read' },
      directory,
    )
    const page = await history(state, id, directory, 'read-history')
    NodeAssert.ok(
      succeeded(read, connection, 'channels.listMessages').length > 0,
      'No approved channels.listMessages receipt',
    )
    NodeAssert.equal(page.messages.at(-1).role, 'assistant')
  } catch (error) {
    failure = error
  }
  await cleanUp(state, { api, channel, nonce, cleanup }, directory)
  await redact(state.evidence, [token], directory)
  if (failure) throw failure
  NodeAssert.deepEqual(cleanup.errors, [], 'Discord cleanup failed')
}
