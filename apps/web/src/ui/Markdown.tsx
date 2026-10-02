import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from './cn'
import { Recover } from './Recover'

/** Stable plugin list: a fresh array each render would make ReactMarkdown rebuild its processor. */
const REMARK_PLUGINS = [remarkGfm]

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
      className={
        href && href.startsWith('/api/library/source')
          ? 'inline-flex rounded-full bg-accent-soft px-2 py-0.5 text-label font-title text-accent-ink no-underline ring-line'
          : 'text-accent-ink underline underline-offset-2'
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
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-control ring-line">
      <table className="w-full border-collapse text-label">{children}</table>
    </div>
  ),
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
  const linkedContent = content
    .replace(TYPED_BULLET, '$1- ')
    .replace(
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
