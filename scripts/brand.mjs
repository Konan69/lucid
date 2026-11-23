#!/usr/bin/env node
/**
 * The product is Lucid; Vivid was its working name. This check fails on the old name in the prose
 * of every tracked Markdown file outside `.agents/` and `refs/`. Code keeps the old identifiers
 * (`@vivid/*`, `VividRpc`, `VIVID_*`, `verify-vivid`), so code spans, code blocks and link
 * destinations are not prose and pass.
 *
 * `node scripts/brand.mjs --write` renames the prose in place and repoints links whose heading
 * anchor changed with it.
 */
import * as NodeChildProcess from 'node:child_process'
import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'

const OLD = /\bVivid\b/gu
const NEW = 'Lucid'
const write = process.argv.includes('--write')

const files = NodeChildProcess.execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.length > 0 && !file.startsWith('.agents/') && !file.startsWith('refs/'))

const CODE_OR_LINK =
  /(`+)[^`]*?\1|\]\([^)]*\)|^\s{0,3}\[[^\]]+\]:\s*\S+|<https?:[^>]*>|https?:\/\/\S+/gu

const renameLine = (line) => {
  let out = ''
  let last = 0
  for (const match of line.matchAll(CODE_OR_LINK)) {
    out += line.slice(last, match.index).replace(OLD, NEW) + match[0]
    last = match.index + match[0].length
  }
  return out + line.slice(last).replace(OLD, NEW)
}

const PROSE_FENCES = new Set(['', 'text', 'mermaid'])

const proseLineIndexes = (lines) => {
  const prose = []
  let fence = null
  let readable = false
  lines.forEach((line, index) => {
    const open = /^\s*(`{3,}|~{3,})\s*([\w-]*)/u.exec(line)
    if (fence === null && open) {
      fence = open[1]
      readable = PROSE_FENCES.has(open[2])
    } else if (
      fence !== null &&
      new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`, 'u').test(line)
    )
      fence = null
    else if (fence === null || readable) prose.push(index)
  })
  return prose
}

const githubAnchorsOf = (source) =>
  new Set(
    proseLineIndexes(source.split('\n'))
      .map((index) => source.split('\n')[index])
      .filter((line) => /^#{1,6}\s/u.test(line))
      .map((line) =>
        line
          .replace(/^#{1,6}\s+/u, '')
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, '')
          .replace(/\s/gu, '-'),
      ),
  )

if (write) {
  const renamed = new Map()
  for (const file of files) {
    const lines = NodeFS.readFileSync(file, 'utf8').split('\n')
    for (const index of proseLineIndexes(lines)) lines[index] = renameLine(lines[index])
    renamed.set(file, lines.join('\n'))
  }
  const LINK = /\]\(([^)#\s]*)#([^)\s]*vivid[^)\s]*)\)/gu
  for (const [file, source] of renamed) {
    const repointed = source.replace(LINK, (whole, target, anchor) => {
      const targetFile = target === '' ? file : NodePath.join(NodePath.dirname(file), target)
      const targetSource = renamed.get(targetFile)
      const next = anchor.replaceAll('vivid', 'lucid')
      return targetSource !== undefined && githubAnchorsOf(targetSource).has(next)
        ? `](${target}#${next})`
        : whole
    })
    if (repointed !== NodeFS.readFileSync(file, 'utf8')) NodeFS.writeFileSync(file, repointed)
  }
}

const failures = files.flatMap((file) => {
  const lines = NodeFS.readFileSync(file, 'utf8').split('\n')
  return proseLineIndexes(lines)
    .filter((index) => renameLine(lines[index]) !== lines[index])
    .map((index) => `${file}:${index + 1} ${lines[index].trim()}`)
})

if (failures.length > 0) {
  console.error(
    `Documents call the product Vivid (${failures.length}). Say Lucid, or run node scripts/brand.mjs --write:\n${failures.join('\n')}`,
  )
  process.exit(1)
}
console.log('Documents call the product Lucid.')
