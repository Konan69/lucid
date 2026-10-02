import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

describe('Markdown', () => {
  it('normalizes prose bullets without changing fenced or indented code', () => {
    const content = '```text\n• fenced\n```\n\n    • indented\n\n• prose'
    const html = renderToStaticMarkup(createElement(Markdown, { content }))

    expect(html).toContain('• fenced')
    expect(html).toContain('• indented')
    expect(html).toContain('<li>prose</li>')
  })
})
