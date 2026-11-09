import * as NodeFSP from 'node:fs/promises'
import * as NodeAssert from 'node:assert/strict'
import { Redacted, Schema } from 'effect'
import { ConnectionState, ConnectionStep } from '@vivid/contracts'
import { decodeText } from './receipts.mjs'
import { history, chat, rpc, json } from './wire.mjs'
import { catalog } from './settingsproof.mjs'
import { allowPending, redact } from './discord.mjs'

const setting = 'VIVID_VERIFY_GITHUB_TOKEN_FILE'
const service = 'curated/github-com-mcp'
const User = Schema.Struct({ login: Schema.String })

/** A GitHub personal token is an external authority. Without it the recipe is blocked, not run. */
export function githubBlocked() {
  return process.env[setting]
    ? {}
    : { github: 'blocked: needs a GitHub personal token. Set ' + setting }
}

/** Who the token belongs to, asked of GitHub directly so the reply can be checked against it.
 * Evidence keeps the status and login; the Authorization header is never written anywhere. */
async function githubLogin(token, directory) {
  const response = await fetch('https://api.github.com/user', {
    headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub GET /user: ${response.status} ${text}`)
  const { login } = decodeText(User, text)
  await json(directory + '/github-user.json', { status: response.status, login })
  return login
}

/** The Key form's calls with "For you": Begin unshared, then Complete with the one masked field. */
async function connectGitHub(state, token, cleanup, directory) {
  const services = await catalog(state, directory, 'GitHub', 'services')
  const listed = services.find((entry) => entry.id === service)
  NodeAssert.ok(listed, 'GitHub is not in the catalog')
  NodeAssert.equal(listed.name, 'GitHub')
  const begun = await rpc(
    state,
    'BeginConnection',
    { service, from: 'Web', name: null, shared: false },
    directory,
  )
  NodeAssert.ok(ConnectionStep.guards.EnterKey(begun), 'GitHub did not ask for a key')
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
  NodeAssert.ok(ConnectionState.guards.Ready(completed.connection.state), 'GitHub is not Ready')
  NodeAssert.equal(completed.connection.serviceName, 'GitHub')
}

/** Connect GitHub with a personal token, then ask in a Person's words who they are on GitHub.
 * The login only reaches the reply through the Integration, since nothing else in the disposable
 * account names it. */
export async function githubProof(state, id, directory) {
  NodeAssert.equal(state.modelKind, 'real', 'GitHub needs a real model')
  const token = (await NodeFSP.readFile(process.env[setting], 'utf8')).trim()
  NodeAssert.ok(token.length > 0, setting + ' is empty')
  const cleanup = { connection: null, removed: false, errors: [] }
  let failure
  try {
    const login = await githubLogin(token, directory)
    await connectGitHub(state, token, cleanup, directory)
    await chat(state, id, "What's my GitHub username?", directory, 'ask')
    await allowPending(state, id, { runs: 1, step: 'ask' }, directory)
    const page = await history(state, id, directory, 'ask-history')
    const last = page.messages.at(-1)
    NodeAssert.equal(last.role, 'assistant')
    const reply = last.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
    await json(directory + '/proof.json', { login, thread: id, connection: cleanup.connection })
    NodeAssert.ok(
      reply.toLowerCase().includes(login.toLowerCase()),
      'Reply does not name the GitHub login: ' + reply,
    )
  } catch (error) {
    failure = error
  }
  if (cleanup.connection)
    await rpc(state, 'RemoveConnection', { id: cleanup.connection }, directory).then(
      () => (cleanup.removed = true),
      (error) => cleanup.errors.push('RemoveConnection: ' + error.message),
    )
  await json(directory + '/cleanup.json', cleanup)
  await redact(state.evidence, [token], directory)
  if (failure) throw failure
  NodeAssert.deepEqual(cleanup.errors, [], 'GitHub cleanup failed')
}
