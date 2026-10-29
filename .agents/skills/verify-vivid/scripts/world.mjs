import * as NodeFSP from 'node:fs/promises'
import * as NodePath from 'node:path'
import { Schema } from 'effect'
import { root } from './process.mjs'
import { decodeText } from './receipts.mjs'

const Message = Schema.Struct({
  from: Schema.String,
  to: Schema.Array(Schema.String),
  date: Schema.String,
  body: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.String)),
})
const Mail = Schema.Struct({
  owner: Schema.Struct({ name: Schema.String, email: Schema.String, timezone: Schema.String }),
  threads: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      subject: Schema.String,
      labels: Schema.Array(Schema.String),
      messages: Schema.Array(Message),
    }),
  ),
})
const Calendar = Schema.Struct({
  timezone: Schema.String,
  calendars: Schema.Array(Schema.Struct({ name: Schema.String })),
  events: Schema.Array(
    Schema.Struct({
      calendar: Schema.String,
      title: Schema.String,
      start: Schema.String,
      end: Schema.String,
      meet: Schema.Boolean,
      attendees: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

/** Private inputs stay outside the checkout. Decode failures deliberately omit supplied values. */
export async function privateJson(directory, name, schema) {
  const path = await NodeFSP.realpath(NodePath.resolve(directory, name))
  if (path === root || path.startsWith(root + '/'))
    throw new Error('World files must be outside the checkout')
  const stat = await NodeFSP.stat(path)
  if ((stat.mode & 0o777) !== 0o600) throw new Error(name + ' must have mode 0600')
  try {
    return decodeText(schema, await NodeFSP.readFile(path, 'utf8'))
  } catch {
    throw new Error('Invalid private JSON or shape in ' + name)
  }
}

/** Sources carry seeds only in memory. Every copied app has its own SQLite effects journal. */
function app(name, source, migration) {
  const id = name.toLowerCase()
  return {
    entry: {
      id,
      package: '@world/' + id,
      name,
      description:
        name === 'Mail'
          ? 'Search, read and send your email.'
          : 'Your calendars, availability and events.',
      auth: [{ method: 'key', kind: 'secrets', label: 'Connection code' }],
      icons: [],
      source: 'apps/' + id + '.json',
    },
    document: {
      package: '@world/' + id,
      files: [
        {
          path: 'package.json',
          content: JSON.stringify({
            name: '@world/' + id,
            dependencies: { apps: '0.0.1-beta.92' },
          }),
        },
        { path: 'index.ts', content: source },
        { path: 'migrations/0001_effects.sql', content: migration },
      ],
    },
  }
}

/** Match Pulse's public secrets-code authorization while keeping service names ordinary. */
function header(name, seed) {
  return `import { defineApp, defineProvider, query, mutation, object, router, secrets, string, boolean, array, number } from "apps";
const seed = ${JSON.stringify(seed)};
const account = defineProvider({ name: ${JSON.stringify(name)}, auth: { key: secrets({ label: "Connection code", fields: object({ code: string() }) }) } });
const requirements = { user: { accounts: { account } } };
`
}

/** Reads join the immutable inbox with committed sends, so a reply is visible on the next call. */
function mailSource(seed) {
  return (
    header('Mail', seed) +
    `
function messages(ctx) { return ctx.sql.exec("SELECT body FROM messages ORDER BY rowid").toArray().map(row => JSON.parse(row.body)); }
function threads(ctx) {
  const threads = seed.threads.map(thread => ({ ...thread, messages: [...thread.messages] }));
  for (const message of messages(ctx)) {
    const thread = threads.find(thread => thread.id === message.threadId);
    if (thread) thread.messages.push(message);
    else threads.push({ id: message.threadId, subject: message.subject, labels: ["SENT"], messages: [message] });
  }
  return threads;
}
const list_threads = query({ description: "Search email threads by words in sender, subject or body, and optionally label or unread status. Returns matching messages, including attachments and dates.", input: object({ query: string().optional(), label: string().optional(), unread: boolean().optional() }) }, async (ctx, input) => ({ owner: seed.owner, threads: threads(ctx).filter(thread =>
  (!input.query || input.query.toLowerCase().split(/\\s+/).every(word => JSON.stringify(thread).toLowerCase().includes(word))) &&
  (!input.label || thread.labels.includes(input.label.toUpperCase())) &&
  (input.unread === undefined || thread.labels.includes("UNREAD") === input.unread)) }));
const read_thread = query({ description: "Read every message of one email thread, including sent replies.", input: object({ threadId: string() }) }, async (ctx, input) => {
  const thread = threads(ctx).find(thread => thread.id === input.threadId);
  if (!thread) throw new Error("Email thread not found");
  return { owner: seed.owner, thread };
});
function send(ctx, input, threadId) {
  const message = { id: crypto.randomUUID(), threadId, from: seed.owner.name + " <" + seed.owner.email + ">", to: input.to, cc: input.cc || [], subject: input.subject, body: input.body, date: new Date().toISOString(), attachments: [] };
  ctx.sql.exec("INSERT INTO messages (id, body) VALUES (?, ?)", message.id, JSON.stringify(message));
  return { sent: message };
}
const send_message = mutation({ description: "Send an email and return the stored sent message. replyToThreadId appends it to an existing thread.", input: object({ to: array(string()), cc: array(string()).optional(), subject: string(), body: string(), replyToThreadId: string().optional() }) }, async (ctx, input) => {
  if (input.replyToThreadId && !threads(ctx).some(thread => thread.id === input.replyToThreadId)) throw new Error("Email thread not found");
  return send(ctx, input, input.replyToThreadId || crypto.randomUUID());
});
const reply = mutation({ description: "Reply to the latest received message of an email thread. Optional to and cc override its recipient.", input: object({ threadId: string(), body: string(), to: array(string()).optional(), cc: array(string()).optional() }) }, async (ctx, input) => {
  const thread = threads(ctx).find(thread => thread.id === input.threadId);
  if (!thread) throw new Error("Email thread not found");
  const received = thread.messages.filter(message => !message.from.includes(seed.owner.email)).at(-1);
  if (!received) throw new Error("Thread has no received message to reply to");
  const sender = /<([^>]+)>/.exec(received.from);
  return send(ctx, { to: input.to || [sender ? sender[1] : received.from], cc: input.cc || [], subject: "Re: " + thread.subject.replace(/^Re: /i, ""), body: input.body }, thread.id);
});
const sent_messages = query({ description: "List committed sent email messages.", input: object({}) }, async ctx => ({ messages: messages(ctx) }));
export default defineApp(requirements, { tools: router({ list_threads, read_thread, send_message, reply, sent_messages }) });
`
  )
}

/** Both calendars contribute busy intervals. Free slots are explicit tool evidence for choices. */
function calendarSource(seed) {
  return (
    header('Calendar', seed) +
    `
function events(ctx) { return seed.events.concat(ctx.sql.exec("SELECT body FROM events ORDER BY rowid").toArray().map(row => JSON.parse(row.body))); }
function range(input) {
  const start = Date.parse(input.start), end = Date.parse(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * 86400000) throw new Error("Use a valid range of at most 31 days");
  return { start, end };
}
const list_events = query({ description: "List events across both calendars in an ISO datetime range. Includes calendars and timezone.", input: object({ start: string(), end: string() }) }, async (ctx, input) => {
  const span = range(input);
  return { timezone: seed.timezone, calendars: seed.calendars, events: events(ctx).filter(event => Date.parse(event.start) < span.end && Date.parse(event.end) > span.start) };
});
const free_busy = query({ description: "Read busy intervals across both calendars and available weekday slots from 09:00 to 18:00 in the calendar timezone. Defaults to 30 minute slots.", input: object({ start: string(), end: string(), durationMinutes: number().optional() }) }, async (ctx, input) => {
  const span = range(input), minutes = input.durationMinutes === undefined ? 30 : input.durationMinutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 540) throw new Error("Duration must be 1 to 540 minutes");
  const busy = events(ctx).filter(event => Date.parse(event.start) < span.end && Date.parse(event.end) > span.start);
  const slots = [];
  for (let start = Math.ceil(span.start / 1800000) * 1800000; start + minutes * 60000 <= span.end; start += 1800000) {
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: seed.timezone, weekday: "short", hour: "2-digit", hourCycle: "h23" }).format(new Date(start));
    const hour = Number(local.match(/\\d{2}/)[0]);
    const endLocal = new Intl.DateTimeFormat("en-GB", { timeZone: seed.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(start + minutes * 60000));
    if (/Sat|Sun/.test(local) || hour < 9 || endLocal > "18:00" || busy.some(event => Date.parse(event.start) < start + minutes * 60000 && Date.parse(event.end) > start)) continue;
    slots.push({ start: new Date(start).toISOString(), end: new Date(start + minutes * 60000).toISOString() });
  }
  return { timezone: seed.timezone, calendars: seed.calendars, busy, slots };
});
const create_event = mutation({ description: "Create an event in a named calendar and return the committed event.", input: object({ calendar: string(), title: string(), start: string(), end: string(), attendees: array(string()).optional() }) }, async (ctx, input) => {
  range(input);
  if (!seed.calendars.some(calendar => calendar.name === input.calendar)) throw new Error("Calendar not found; list events to see calendar names");
  const event = { id: crypto.randomUUID(), calendar: input.calendar, title: input.title, start: input.start, end: input.end, attendees: input.attendees || [], meet: false };
  ctx.sql.exec("INSERT INTO events (id, body) VALUES (?, ?)", event.id, JSON.stringify(event));
  return { created: event };
});
const created_events = query({ description: "List events created in your calendars.", input: object({}) }, async ctx => ({ events: ctx.sql.exec("SELECT body FROM events ORDER BY rowid").toArray().map(row => JSON.parse(row.body)) }));
export default defineApp(requirements, { tools: router({ list_events, free_busy, create_event, created_events }) });
`
  )
}

/** Unset means the existing Pulse-only catalogue. Private files are never written to disk here. */
export async function worldApps(directory) {
  if (!directory) return []
  const mail = await privateJson(directory, 'mail.json', Mail)
  const calendar = await privateJson(directory, 'calendar.json', Calendar)
  return [
    app(
      'Mail',
      mailSource(mail),
      'CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT NOT NULL);',
    ),
    app(
      'Calendar',
      calendarSource(calendar),
      'CREATE TABLE events (id TEXT PRIMARY KEY, body TEXT NOT NULL);',
    ),
  ]
}
