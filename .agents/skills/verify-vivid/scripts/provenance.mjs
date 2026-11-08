import { Schema, Predicate } from 'effect'

const Value = Schema.Struct({
  kind: Schema.Literals(['email', 'phone', 'amount', 'date', 'time', 'reference', 'name']),
  value: Schema.String,
  keys: Schema.NonEmptyArray(Schema.String),
})
const Checked = Schema.Struct({
  kind: Value.fields.kind,
  value: Value.fields.value,
  location: Schema.String,
  supported: Schema.Boolean,
})
const canonical = (text) => text.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ')
const month =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
const currency = '(?:NGN|USD|GBP|EUR|₦|\\$|£|€)'
const number = '\\d+(?:[ ,]\\d{3})*(?:\\.\\d{1,2})?(?:[kKmM])?'
const patterns = {
  email: /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,
  reference: /\b(?=[a-z0-9\-‐‑–]*\d)[a-z][a-z0-9]{1,15}[-‐‑–][a-z0-9]+(?:[-‐‑–][a-z0-9]+)*\b/gi,
  amount: new RegExp(currency + '\\s*' + number + '|\\b' + number + '\\s*' + currency, 'gi'),
  date: new RegExp(
    '\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b|\\b\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+' +
      month +
      '(?:,?\\s+\\d{4})?\\b|\\b' +
      month +
      '\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b',
    'gi',
  ),
  time: /(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s*[ap]\.?m\.?)?(?:\s*(?:UTC|GMT|WAT))?|\b(?:1[0-2]|[1-9])\s*[ap]\.?m\.?(?:\s*(?:UTC|GMT|WAT))?/gi,
  phone: /(?<![\w])\+?\d[\d ()-]{5,}\d(?![\w])/g,
}

/** Calendar dates compare as ISO days. Missing years use the captured run date, never wall time. */
function day(raw, reference) {
  const numeric = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(raw)
  let parsed
  if (numeric) {
    const [first, middle, last] = numeric.slice(1).map(Number)
    const year = numeric[1].length === 4 ? first : last < 100 ? 2000 + last : last
    const date = numeric[1].length === 4 ? last : first
    parsed = new Date(Date.UTC(year, middle - 1, date))
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== middle - 1 ||
      parsed.getUTCDate() !== date
    )
      return []
  } else {
    const text = raw.replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1')
    parsed = new Date(
      Date.parse((/\b\d{4}\b/.test(text) ? text : text + ' ' + reference.slice(0, 4)) + ' UTC'),
    )
  }
  return Number.isFinite(parsed.valueOf()) ? [parsed.toISOString().slice(0, 10)] : []
}

/** Use integer cents so symbols, codes, grouping and trailing zeroes cannot change the amount. */
function money(raw) {
  const code = /NGN|USD|GBP|EUR|₦|\$|£|€/i.exec(raw)[0].toUpperCase()
  const units = {
    '₦': 'NGN',
    $: 'USD',
    '£': 'GBP',
    '€': 'EUR',
    NGN: 'NGN',
    USD: 'USD',
    GBP: 'GBP',
    EUR: 'EUR',
  }
  const digits = raw.replace(/NGN|USD|GBP|EUR|₦|\$|£|€|[ ,]/gi, '')
  const parts = /^(\d+)(?:\.(\d{1,2}))?([kKmM]?)$/.exec(digits)
  if (parts === null) return []
  const fraction = parts[2] === undefined ? '00' : parts[2].padEnd(2, '0')
  const scale = { '': 1n, k: 1000n, m: 1000000n }[parts[3].toLowerCase()]
  return [units[code] + ':' + String((BigInt(parts[1]) * 100n + BigInt(fraction)) * scale)]
}

/** Clock values have second precision. An explicit zone is converted to UTC before comparison. */
function clock(raw, context) {
  const match = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(UTC|GMT|WAT)?$/i.exec(
    raw.trim(),
  )
  if (match === null) return []
  let hour = Number(match[1])
  if (match[4] && (hour < 1 || hour > 12)) return []
  if (match[4]) hour = (hour % 12) + (/^p/i.test(match[4]) ? 12 : 0)
  const minute = match[2] === undefined ? 0 : Number(match[2])
  const second = match[3] === undefined ? 0 : Number(match[3])
  const explicit = match[5] === undefined ? context.zone : match[5].toUpperCase()
  const offset = offsetSeconds(explicit, context.reference)
  const seconds = (hour * 3600 + minute * 60 + second - offset + 86400) % 86400
  return [String(seconds)]
}

/** IANA offsets come from ICU at the captured date; the scorer never depends on the host's timezone. */
function offsetSeconds(zone, reference) {
  if (zone === 'WAT') return 3600
  if (zone === 'UTC' || zone === 'GMT') return 0
  const part = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(reference))
    .find((item) => item.type === 'timeZoneName')
  if (part.value === 'GMT') return 0
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part.value)
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600 + Number(match[3]) * 60)
}

/** More specific spans own their bytes, so dates, references and amounts cannot become phones. */
function valuesIn(text, context) {
  const occupied = []
  const found = []
  const stamp = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g
  for (const match of text.matchAll(stamp)) {
    const instant = new Date(match[0])
    if (!Number.isFinite(instant.valueOf())) continue
    occupied.push([match.index, match.index + match[0].length])
    const localDay = new Intl.DateTimeFormat('sv-SE', {
      timeZone: context.zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant)
    const seconds =
      instant.getUTCHours() * 3600 + instant.getUTCMinutes() * 60 + instant.getUTCSeconds()
    found.push(
      Value.make({ kind: 'date', value: match[0], keys: [localDay] }),
      Value.make({ kind: 'time', value: match[0], keys: [String(seconds)] }),
    )
  }
  for (const [kind, pattern] of Object.entries(patterns)) {
    for (const match of text.matchAll(pattern)) {
      const span = [match.index, match.index + match[0].length]
      if (occupied.some(([start, end]) => span[0] < end && span[1] > start)) continue
      const keys = keysFor(kind, match[0], context)
      if (keys.length === 0) continue
      found.push(Value.make({ kind, value: match[0], keys }))
      occupied.push(span)
    }
  }
  return found
}

/** Each closed value kind owns its normal form; unparsed candidates are not scored. */
function keysFor(kind, raw, context) {
  const readers = {
    email: (value) => [canonical(value)],
    phone: (value) => {
      const digits = value.replace(/\D/g, '')
      return digits.length >= 7 && digits.length <= 15 ? [digits] : []
    },
    reference: (value) => [value.toUpperCase().replace(/[‐‑–]/g, '-')],
    amount: money,
    date: (value) => day(value, context.reference),
    time: (value) => clock(value, context),
  }
  return readers[kind](raw)
}

/** Mailboxes and attendee fields supply identities. No capitalization or prose token guessing. */
function identities(value) {
  const mailbox = /^\s*"?([^<>]*?)"?\s*<([^<>]+)>\s*$/.exec(value)
  return mailbox
    ? [mailbox[1].trim(), mailbox[2].trim()].filter(Boolean)
    : [value.trim()].filter(Boolean)
}

/** The private world contributes people only. Shaped values still need preceding Thread evidence. */
export function provenanceContext(world, reference) {
  const messages = world.mail.threads.flatMap((thread) => thread.messages)
  const mail = messages.flatMap((message) => [
    message.from,
    ...message.to,
    ...(message.cc === undefined ? [] : message.cc),
  ])
  const calendar = world.calendar.events.flatMap((event) => [
    event.title,
    ...(event.attendees === undefined ? [] : event.attendees),
  ])
  const people = [
    ...mail.flatMap(identities),
    ...calendar.flatMap((value) => value.split(/\s*(?:<>|:|\s-\s|\bwith\b|&)\s*/i)),
  ]
    .values()
    .map(canonical)
    .filter(Boolean)
    .toArray()
  return { people: new Set(people), zone: world.calendar.timezone, reference }
}

/** A recipient can be a full display name, its address, or a name explicitly present in evidence. */
function person(value, source, location, context) {
  const knownText = canonical(source)
  return identities(value).map((identity) => {
    const key = canonical(identity)
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const supported =
      context.people.has(key) ||
      new RegExp('(?<![\\p{L}\\p{N}_])' + escaped + '(?![\\p{L}\\p{N}_])', 'u').test(knownText)
    return Checked.make({ kind: 'name', value: identity, location, supported })
  })
}

/** Names are considered only in explicit recipient and attendee fields or a To-labelled component. */
export function personFields(values, source, location, context) {
  return values.flatMap((value) => person(value, source, location, context))
}
export function displayPeople(drawn, source, location, context) {
  if (!Predicate.isObjectOrArray(drawn)) return []
  if (Array.isArray(drawn))
    return drawn.flatMap((value) => displayPeople(value, source, location, context))
  const children = Object.values(drawn).flatMap((value) =>
    displayPeople(value, source, location, context),
  )
  if (drawn.type !== 'element' || !['Button', 'Caption', 'Title', 'Text'].includes(drawn.typeName))
    return children
  const strings = Object.values(drawn.props).filter(Predicate.isString)
  const recipients = strings.flatMap((value) => {
    const match = /^To\s*:?\s+([^\n]+)$/i.exec(value.trim())
    return match ? [match[1].split(/\s+[—–]|\s+-\s+|\s+(?:about|regarding|for)\s+/i)[0]] : []
  })
  return children.concat(personFields(recipients, source, location, context))
}

/** Comparison uses typed normalized keys, never partial raw-text matches or an external judge. */
export function provenance(text, source, location, context) {
  const available = new Set(
    valuesIn(source, context).flatMap((item) => item.keys.map((key) => item.kind + ':' + key)),
  )
  const values = valuesIn(text, context)
  return values.map((item) =>
    Checked.make({
      kind: item.kind,
      value: item.value,
      location,
      supported: item.keys.some((key) => available.has(item.kind + ':' + key)),
    }),
  )
}

/** A write is checked against the reads preceding its receipt, including its closed identity fields. */
export function effectProvenance(kind, record, source, context) {
  const location = kind + '/' + record.id
  const fields =
    kind === 'mail'
      ? [record.subject, record.body, ...record.to, ...record.cc]
      : [record.title, record.start, record.end, ...record.attendees]
  const people = kind === 'mail' ? record.to.concat(record.cc) : record.attendees
  return provenance(fields.join('\n'), source, location, context).concat(
    personFields(people, source, location, context),
  )
}
