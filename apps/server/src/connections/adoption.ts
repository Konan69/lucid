import { Effect, Schema } from 'effect'
import type { MadeFile } from '@vivid/contracts'

/** Source outside the three generated user-account factory shapes is left working and untouched. */
export class AdoptionSourceUnsupported extends Schema.TaggedError<AdoptionSourceUnsupported>()(
  'AdoptionSourceUnsupported',
  { reason: Schema.Literals(['Requirement', 'Factory', 'AccountRead', 'Index']) },
  { title: 'Integration adoption source unsupported' },
) {}

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
  if (declaration === null || declaration[1] === undefined)
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
