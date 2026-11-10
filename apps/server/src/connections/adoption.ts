import { Effect, Schema } from 'effect'
import type { MadeFile } from '@vivid/contracts'
import { appsVersion } from './framework.ts'

/** Unsupported declarations remain working under their existing installation authority. */
export class AdoptionSourceUnsupported extends Schema.TaggedError<AdoptionSourceUnsupported>()(
  'AdoptionSourceUnsupported',
  { reason: Schema.Literals(['Requirement', 'Factory', 'AccountRead', 'Index', 'Manifest']) },
  { title: 'Integration adoption source unsupported' },
) {}

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)
const decodeDependencies = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))

/** The captured Google and GitHub workspaces pin pre-scope frameworks. Upgrade only apps;
 * package identity, other dependencies and every provider declaration stay unchanged. */
const pinAdoptionFramework = Effect.fn('Connections.pinAdoptionFramework')(function* (
  files: ReadonlyArray<MadeFile>,
) {
  const file = files.find((entry) => entry.path === 'package.json')
  if (file === undefined) return yield* new AdoptionSourceUnsupported({ reason: 'Manifest' })
  const manifest = yield* decodeManifest(file.content).pipe(
    Effect.mapError(() => new AdoptionSourceUnsupported({ reason: 'Manifest' })),
  )
  const dependencies = yield* decodeDependencies(manifest['dependencies']).pipe(
    Effect.mapError(() => new AdoptionSourceUnsupported({ reason: 'Manifest' })),
  )
  const previous = dependencies['apps']
  if (previous === undefined || !['0.0.1-beta.19', '0.0.1-beta.22'].includes(previous))
    return yield* new AdoptionSourceUnsupported({ reason: 'Manifest' })
  const content = JSON.stringify({
    ...manifest,
    dependencies: { ...dependencies, apps: appsVersion },
  })
  return files.map((entry) =>
    entry.path === 'package.json' ? { path: entry.path, content } : entry,
  )
})

/** Exact deployed snapshots use a plain account, including GitHub's shorthand `{ service }`.
 * Bridge it through many() so the member can evaluate without a user link, then project the
 * one bound account back into the original factory. Its router, names, schemas and data stay
 * intact. Exact Google beta.22 and GitHub beta.19 workspaces are captured in adoption.live.test.ts. */
const adoptSingleFiles = Effect.fn('Connections.adoptSingleFiles')(function* (
  files: ReadonlyArray<MadeFile>,
  original: string,
  adopted: string,
  index: MadeFile,
) {
  const escaped = original.replaceAll('$', '\\$')
  const requirement = new RegExp(
    `accounts:\\s*\\{\\s*${escaped}(?:\\s*:\\s*([\\w$]+))?\\s*\\}`,
    'u',
  )
  const declaration = requirement.exec(index.content)
  if (declaration === null) return yield* new AdoptionSourceUnsupported({ reason: 'Requirement' })
  if (!/async\s*\(\{\s*accounts\b/u.test(index.content))
    return yield* new AdoptionSourceUnsupported({ reason: 'Factory' })
  const provider = declaration[1] === undefined ? original : declaration[1]
  const read = new RegExp(`(?<![\\w$./])accounts\\.${escaped}\\b`, 'gu')
  if (!read.test(index.content))
    return yield* new AdoptionSourceUnsupported({ reason: 'AccountRead' })
  const selected = `((user?.accounts.${original}?.length ?? 0) > 0 ? user.accounts.${original}[0] : app.accounts.${adopted}[0])`
  const content =
    `/* vivid-adoption:${original}:${adopted} */\n` +
    index.content
      .replace(
        requirement,
        `user: { accounts: { ${original}: ${provider}.many() } }, app: { accounts: { ${adopted}: ${provider}.many() } }`,
      )
      .replace(/async\s*\(\{\s*accounts\b/u, 'async ({ user, app')
      // beta.92 mcpCatalog requires the selected account for credential-bearing metadata.
      .replace(
        new RegExp(`accountId:\\s*accounts\\.${escaped}\\.id`, 'u'),
        `account: accounts.${original}`,
      )
      .replace(read, selected)
  return yield* pinAdoptionFramework(
    files.map((file) => (file.path === 'index.ts' ? { path: file.path, content } : file)),
  )
})

/** Keep the original user requirement until the member principal commits. Both requirements use
 * the very same provider declaration, so linking reuses the existing account and its OAuth grant.
 * Google, keyed catalogue MCP and imported MCP all emit this one many-account factory shape in
 * beta.23 (google.ts, keyed.ts and upstream app-templates/src/implementation/mcp.ts).
 * The marker makes a crash after deploy safe to resume without duplicating the transformation.
 */
export const adoptionFiles = Effect.fn('Connections.adoptionFiles')(function* (
  files: ReadonlyArray<MadeFile>,
  original: string,
  adopted: string,
) {
  const index = files.find((file) => file.path === 'index.ts')
  if (index === undefined) return yield* new AdoptionSourceUnsupported({ reason: 'Index' })
  const marker = `/* vivid-adoption:${original}:${adopted} */`
  if (index.content.includes(marker)) return files
  // Only generated identifier slots are accepted; a computed requirement needs an authored port.
  if (!/^[A-Za-z_$][\w$]*$/u.test(original) || !/^[A-Za-z_$][\w$]*$/u.test(adopted))
    return yield* new AdoptionSourceUnsupported({ reason: 'Requirement' })
  const escaped = original.replaceAll('$', '\\$')
  const requirement = new RegExp(
    `user:\\s*\\{\\s*accounts:\\s*\\{\\s*${escaped}:\\s*([\\w$]+)\\.many\\(\\)\\s*\\}\\s*\\}`,
    'u',
  )
  const declaration = requirement.exec(index.content)
  if (declaration === null) return yield* adoptSingleFiles(files, original, adopted, index)
  if (declaration[1] === undefined)
    return yield* new AdoptionSourceUnsupported({ reason: 'Requirement' })
  if (!/async\s*\(\{\s*user\b/u.test(index.content))
    return yield* new AdoptionSourceUnsupported({ reason: 'Factory' })
  const read = new RegExp(`user(?:\\?)?\\.accounts\\.${escaped}\\b`, 'gu')
  if (!read.test(index.content))
    return yield* new AdoptionSourceUnsupported({ reason: 'AccountRead' })
  const linked = `app.accounts.${adopted}`
  const content =
    marker +
    '\n' +
    index.content
      .replace(
        requirement,
        `${declaration[0]}, app: { accounts: { ${adopted}: ${declaration[1]}.many() } }`,
      )
      .replace(/async\s*\(\{\s*user\b/u, 'async ({ app, user')
      .replace(/if \(user === undefined\)/gu, `if (user === undefined && ${linked}.length === 0)`)
      .replace(
        read,
        `((user?.accounts.${original}?.length ?? 0) > 0 ? user.accounts.${original} : ${linked})`,
      )
  return files.map((file) => (file.path === 'index.ts' ? { path: file.path, content } : file))
})

/** Only the marked bridge declaration is retired after the row commits; app identity, migrations,
 * provider definitions and every other source byte remain the deployed snapshot's own. */
export const adoptedFiles = Effect.fn('Connections.adoptedFiles')(function* (
  files: ReadonlyArray<MadeFile>,
  original: string,
  adopted: string,
) {
  const index = files.find((file) => file.path === 'index.ts')
  if (index === undefined || !index.content.includes(`/* vivid-adoption:${original}:${adopted} */`))
    return yield* new AdoptionSourceUnsupported({ reason: 'Index' })
  const requirement = new RegExp(
    `user:\\s*\\{\\s*accounts:\\s*\\{\\s*${original.replaceAll('$', '\\$')}:\\s*[\\w$]+\\.many\\(\\)\\s*\\}\\s*\\},\\s*`,
    'u',
  )
  const content = index.content.replace(requirement, '')
  if (content === index.content) return files
  return files.map((file) => (file.path === 'index.ts' ? { path: file.path, content } : file))
})
