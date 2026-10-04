import { pages } from '../data/pages'
import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from './cn'
import { Recover } from './Recover'

/** Stable plugin list: a fresh array each render would make ReactMarkdown rebuild its processor. */
const REMARK_PLUGINS = [remarkGfm]

/** What the table's copy control says for each thing that can have happened to the last press. */
const COPY_TABLE = {
  idle: 'Copy table',
  copied: 'Copied',
  refused: 'Could not copy',
} satisfies Record<'idle' | 'copied' | 'refused', string>

/**
 * A table as a spreadsheet takes it: one row per line, cells separated by tabs. Pasted into
 * Sheets, Excel or Numbers this lands as cells, which comma-separated text pasted from a
 * clipboard does not. A tab or a line break inside a cell becomes a space, so it cannot split one.
 */
const asCells = (table: HTMLTableElement) =>
  Array.from(table.rows)
    .map((row) =>
      Array.from(row.cells)
        .map((cell) => cell.innerText.replaceAll(/[\t\n\r]+/gu, ' ').trim())
        .join('\t'),
    )
    .join('\n')

/**
 * A table in a reply, with one press to take it elsewhere. A comparison or a schedule is usually
 * on its way to a spreadsheet, and selecting a rendered table by hand copies its layout, not its
 * cells. The control sits under the table, where it covers nothing and a touch screen can reach it.
 */
function Table({ children }: { children: ReactNode }) {
  const [state, setState] = useState<keyof typeof COPY_TABLE>('idle')
  return (
    <div data-table className="my-3">
      <div className="overflow-x-auto rounded-control ring-line">
        <table className="w-full border-collapse text-label">{children}</table>
      </div>
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          onClick={(event) => {
            // The table is read from the page as it is drawn: it is the control's own sibling.
            const block = event.currentTarget.closest('[data-table]')
            const table = block === null ? null : block.querySelector('table')
            if (table === null || !('clipboard' in navigator)) {
              setState('refused')
              return
            }
            void navigator.clipboard.writeText(asCells(table)).then(
              () => setState('copied'),
              () => setState('refused'),
            )
          }}
          onBlur={() => setState('idle')}
          onMouseLeave={() => setState('idle')}
          className="cursor-pointer rounded-xs px-1 text-meta font-meta text-ink-3 transition-colors duration-(--dur-fast) hover:text-ink"
        >
          {COPY_TABLE[state]}
        </button>
      </div>
    </div>
  )
}

/**
 * Element renderers for message Markdown. Module scope keeps their identity stable, so a
 * streamed token re-renders text instead of remounting every paragraph, link and table.
 */
const MARKDOWN_COMPONENTS: Components = {
  a: ({ children, href, ...props }) => (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        // In the desktop app a link from a reply opens beside the Thread, in a page of its own,
        // instead of sending the Person away to another window. Anywhere else it is a link.
        if (!pages.available || href === undefined || !/^https?:/u.test(href)) return
        event.preventDefault()
        pages.open(href)
      }}
      className={
        href && href.startsWith('/api/library/source')
          ? 'inline-flex rounded-full bg-primary-soft px-2 py-0.5 text-label font-title text-primary-ink no-underline ring-line'
          : 'text-primary-ink underline underline-offset-2'
      }
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-line-3 pl-3 text-ink-3">{children}</blockquote>
  ),
  code: ({ children, className, ...props }) => (
    <code
      {...props}
      className={cn('rounded-xs bg-surface-2 px-1 py-0.5 font-mono text-inline-code', className)}
    >
      {children}
    </code>
  ),
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-page font-title first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-dialog font-title first:mt-0">{children}</h2>,
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-title font-title first:mt-0">{children}</h3>
  ),
  hr: () => <hr className="my-4 border-line-2" />,
  li: ({ children }) => <li className="ml-5 pl-1 marker:text-ink-4">{children}</li>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1">{children}</ol>,
  p: ({ children }) => <p className="my-2 whitespace-pre-wrap first:mt-0 last:mb-0">{children}</p>,
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-control bg-surface-2 p-3 text-label ring-line [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => <Table>{children}</Table>,
  td: ({ children }) => <td className="border-t border-line-2 px-3 py-2 align-top">{children}</td>,
  th: ({ children }) => <th className="bg-surface-2 px-3 py-2 text-left font-title">{children}</th>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1">{children}</ul>,
}

/**
 * A line that opens with a typed bullet character. Models often write lists with "•" instead of
 * Markdown's "-", and Markdown reads those as ordinary paragraphs: the list loses its indent and
 * marker, and a blank line the model left between two items shows as a hole in the list.
 */
const TYPED_BULLET = /^([ \t]*)[•●▪◦‣][ \t]+/gm

/**
 * Normalize typed bullets only in prose. Markdown code fences and four-space/tab-indented code
 * preserve literal source because changing their contents would misrepresent the reply.
 */
function normalizeTypedBullets(content: string) {
  let fence: { readonly marker: string; readonly length: number } | null = null
  return content
    .split('\n')
    .map((line) => {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
      const capturedMarker = fenceMatch === null ? undefined : fenceMatch[1]
      const marker = capturedMarker === undefined ? null : capturedMarker
      if (fence !== null) {
        if (
          marker !== null &&
          marker[0] === fence.marker &&
          marker.length >= fence.length &&
          line.slice(line.indexOf(marker) + marker.length).trim().length === 0
        ) {
          fence = null
        }
        return line
      }
      if (marker !== null) {
        fence = { marker: marker.charAt(0), length: marker.length }
        return line
      }
      if (/^(?: {4}|\t)/u.test(line)) return line
      return line.replace(TYPED_BULLET, '$1- ')
    })
    .join('\n')
}

/** A message as it was written, for when it cannot be formatted. */
function Plain({ content }: { content: string }) {
  return <p className="whitespace-pre-wrap">{content}</p>
}

/**
 * A message's words, formatted. Memoised on the words: while a reply streams, the Thread
 * re-renders for every token, and parsing Markdown is the expensive part of a message. Every
 * reply above the one being written has the same words as last time and is not parsed again.
 */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const linkedContent = normalizeTypedBullets(content).replace(
    /\[([^\]\n]+?\.(?:pdf|md|markdown|txt))(?:,\s*p\.(\d+))?\](?!\()/gi,
    (_match, filename: string, page?: string) => {
      const label = page ? `${filename}, p.${page}` : filename
      const fragment = page ? `#page=${page}` : ''
      return `[${label}](</api/library/source?name=${encodeURIComponent(filename)}${fragment}>)`
    },
  )
  return (
    <div className="min-w-0 text-body text-ink">
      {/* A reply the formatter cannot draw is still a reply: it is shown as it was written, and
          tried again when more of it arrives. One bad message must not take the Thread with it. */}
      <Recover from={linkedContent} fallback={<Plain content={content} />}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {linkedContent}
        </ReactMarkdown>
      </Recover>
    </div>
  )
})
