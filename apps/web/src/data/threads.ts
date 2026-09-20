import type { Thread } from '@vivid/contracts'

export type RuntimeConversation = Omit<Thread, 'id'> & { id: string }

export function plainPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' code ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function titleFromMessage(message: string) {
  const firstLine = message.trim().split('\n', 1)[0] ?? 'New conversation'
  return firstLine.length > 46 ? `${firstLine.slice(0, 45).trimEnd()}…` : firstLine
}
