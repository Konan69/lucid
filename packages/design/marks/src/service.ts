import type { MarkFigure } from './figure.js'

/**
 * The third-party services Vivid can act through, drawn as their own brand marks so a row of them
 * reads at a glance. These are the providers behind a Connection; the identifiers match the
 * `ConnectionId` the server reports, which is how a Connection row finds its mark.
 */
export const SERVICE_MARK_IDS = [
  'gmail',
  'calendar',
  'drive',
  'maps',
  'browser',
  'notes',
  'imessage',
  'whatsapp',
] as const

export type ServiceMarkId = (typeof SERVICE_MARK_IDS)[number]

export type ServiceMark = {
  /** The provider's own name, used as the accessible label; it is not Vivid vocabulary. */
  readonly label: string
  readonly figures: readonly MarkFigure[]
}

/**
 * Geometry in each brand's own colours. Declaring the record against `ServiceMarkId` means adding
 * an identifier to `SERVICE_MARK_IDS` without drawing it fails to typecheck, so the vocabulary and
 * the artwork cannot drift apart.
 */
export const SERVICE_MARKS = {
  gmail: {
    label: 'Gmail',
    figures: [
      { kind: 'rect', x: 0, y: 0, width: 24, height: 24, radius: 5, fill: '#fff' },
      {
        kind: 'path',
        fill: '#EA4335',
        opacity: 1,
        d: 'M3 6.5 12 13l9-6.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z',
      },
      {
        kind: 'path',
        fill: '#C5221F',
        opacity: 1,
        d: 'M3 5.6c0-1.4 1.6-2.2 2.7-1.4L12 8.9l6.3-4.7c1.1-.8 2.7 0 2.7 1.4v.9L12 13 3 6.5v-.9Z',
      },
    ],
  },
  calendar: {
    label: 'Google Calendar',
    figures: [
      { kind: 'rect', x: 0, y: 0, width: 24, height: 24, radius: 5, fill: '#1A73E8' },
      { kind: 'rect', x: 4.5, y: 4.5, width: 15, height: 15, radius: 2, fill: '#fff' },
      {
        kind: 'glyph',
        x: 12,
        y: 15.6,
        text: '31',
        fontSize: 8.4,
        fontWeight: 700,
        fill: '#1A73E8',
      },
    ],
  },
  drive: {
    label: 'Google Drive',
    figures: [
      { kind: 'rect', x: 0, y: 0, width: 24, height: 24, radius: 5, fill: '#fff' },
      {
        kind: 'path',
        fill: '#0066DA',
        opacity: 1,
        d: 'M8.6 4.5h6.8l6 10.4h-6.8z',
        transform: 'translate(-3 0)',
      },
      {
        kind: 'path',
        fill: '#00AC47',
        opacity: 1,
        d: 'M12 4.5 5.5 15.8l3.4 5.9L15.4 10.4z',
        transform: 'translate(0 -1) scale(0.92)',
      },
      { kind: 'path', fill: '#FFBA00', opacity: 1, d: 'm9 21.5 3.4-5.9h9.2l-3.4 5.9z' },
      { kind: 'path', fill: '#00832D', opacity: 1, d: 'M5.5 15.8 8.9 21.5l3.4-5.9z' },
      { kind: 'path', fill: '#2684FC', opacity: 1, d: 'M8.9 3.5 5.5 9.4l3.4 5.9 3.4-5.9z' },
      { kind: 'path', fill: '#00AC47', opacity: 1, d: 'M15.7 3.5H8.9l3.4 5.9z' },
      { kind: 'path', fill: '#FFBA00', opacity: 1, d: 'M21.9 15.3h-6.8l-3.4 5.9h6.8z' },
      { kind: 'path', fill: '#0066DA', opacity: 1, d: 'm15.7 3.5-3.4 5.9 3.4 5.9 3.4-5.9z' },
    ],
  },
  maps: {
    label: 'Google Maps',
    figures: [
      { kind: 'rect', x: 0, y: 0, width: 24, height: 24, radius: 5, fill: '#fff' },
      { kind: 'path', fill: '#34A853', opacity: 1, d: 'M4 20 10 4h4L8 20H4Z' },
      { kind: 'path', fill: '#4285F4', opacity: 1, d: 'M14 4h6v16h-3L14 4Z' },
      { kind: 'path', fill: '#FBBC04', opacity: 0.55, d: 'M10 4h4l-6 16H4l6-16Z' },
      {
        kind: 'path',
        fill: '#EA4335',
        opacity: 1,
        d: 'M12 8.2a3.4 3.4 0 0 1 3.4 3.4c0 2.5-3.4 6-3.4 6s-3.4-3.5-3.4-6A3.4 3.4 0 0 1 12 8.2Z',
      },
      { kind: 'circle', cx: 12, cy: 11.5, r: 1.3, fill: '#7C2B22' },
    ],
  },
  browser: {
    label: 'Chrome',
    figures: [
      { kind: 'circle', cx: 12, cy: 12, r: 11, fill: '#fff' },
      { kind: 'ring', cx: 12, cy: 12, r: 4.6, fill: '#fff', stroke: '#1A73E8', strokeWidth: 2.4 },
      {
        kind: 'path',
        fill: '#EA4335',
        opacity: 1,
        d: 'M12 1a11 11 0 0 1 9.5 5.5H12a5.5 5.5 0 0 0-5.2 3.7L3.3 4.7A11 11 0 0 1 12 1Z',
      },
      {
        kind: 'path',
        fill: '#FBBC05',
        opacity: 1,
        d: 'M3.3 4.7 8.6 13.7a5.5 5.5 0 0 0 4.6 3.7l-3.4 6A11 11 0 0 1 3.3 4.7Z',
        transform: 'translate(0.4 0)',
      },
      {
        kind: 'path',
        fill: '#34A853',
        opacity: 1,
        d: 'M22.9 9.3a11 11 0 0 1-13 12.1l4.4-7.6a5.5 5.5 0 0 0 3.2-4.5h5.4Z',
      },
    ],
  },
  notes: {
    label: 'Google Keep',
    figures: [
      { kind: 'rect', x: 0, y: 0, width: 24, height: 24, radius: 5, fill: '#FBBC04' },
      {
        kind: 'path',
        fill: '#fff',
        opacity: 1,
        d: 'M12 5.5a4.5 4.5 0 0 1 2.5 8.2v1.8h-5v-1.8A4.5 4.5 0 0 1 12 5.5Z',
      },
      { kind: 'rect', x: 10.4, y: 16.6, width: 3.2, height: 1.6, radius: 0.8, fill: '#fff' },
    ],
  },
  // The two messaging apps a Person can text Vivid from. They are not behind a Connection (their
  // identifiers are the `Channel` in lower case, not a `ConnectionId`), but they are drawn the
  // same way for the same reason: the app is recognised by its mark before its name is read.
  imessage: {
    label: 'iMessage',
    figures: [
      { kind: 'rect', x: 0, y: 0, width: 24, height: 24, radius: 5, fill: '#34C759' },
      {
        kind: 'path',
        fill: '#fff',
        opacity: 1,
        d: 'M12 5.5c4.1 0 7.5 2.7 7.5 6s-3.4 6-7.5 6c-.8 0-1.6-.1-2.3-.3-.9.8-2.1 1.3-3.5 1.4.7-.7 1.2-1.5 1.3-2.4-1.9-1.100-3-2.800-3-4.700 0-3.300 3.400-6 7.500-6Z',
      },
    ],
  },
  whatsapp: {
    label: 'WhatsApp',
    figures: [
      { kind: 'rect', x: 0, y: 0, width: 24, height: 24, radius: 5, fill: '#25D366' },
      { kind: 'path', fill: '#fff', opacity: 1, d: 'm5.400 18.600 1.300-4.200 2.900 2.900z' },
      { kind: 'ring', cx: 12, cy: 12, r: 6, fill: '#25D366', stroke: '#fff', strokeWidth: 1.5 },
      {
        kind: 'path',
        fill: '#fff',
        opacity: 1,
        d: 'M10 9.200c.3-.3.8-.3 1 .1l.5 1c.1.3 0 .6-.2.8l-.3.3c.5.9 1.200 1.600 2.100 2.100l.3-.3c.2-.2.5-.3.8-.2l1 .5c.4.2.4.7.1 1-.6.7-1.500.9-2.300.6-1.900-.7-3.400-2.200-4.100-4.100-.2-.7 0-1.300.6-1.800Z',
      },
    ],
  },
} satisfies Record<ServiceMarkId, ServiceMark>

/**
 * Narrows an arbitrary identifier — a `ConnectionId` from the server, say — to one Vivid has
 * artwork for. A surface that has not drawn a provider yet shows its own placeholder, so absence
 * stays a branch the caller handles rather than a missing lookup.
 */
export function isServiceMarkId(id: string): id is ServiceMarkId {
  return Object.hasOwn(SERVICE_MARKS, id)
}
