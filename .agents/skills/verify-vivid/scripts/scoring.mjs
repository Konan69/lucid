import * as NodeFSP from 'node:fs/promises'
import * as NodeModule from 'node:module'
import { Schema, Predicate } from 'effect'
import { decodeText } from './receipts.mjs'
import { root } from './process.mjs'
import { provenance, displayPeople, effectProvenance } from './provenance.mjs'

const require = NodeModule.createRequire(root + '/packages/agent/runtime/package.json')
const { ToolName } = await import(require.resolve('@vivid/contracts'))
const { createParser, createStore, evaluateRoot } = await import(
  require.resolve('@openuidev/lang-core')
)
const DisplaySpec = Schema.Struct({
  root: Schema.String,
  schema: Schema.Record(Schema.String, Schema.Json),
})
const spec = decodeText(
  DisplaySpec,
  await NodeFSP.readFile(root + '/packages/agent/runtime/src/agents/parts.json', 'utf8'),
)
const parser = createParser(spec.schema, spec.root)
const fences = /```openui-lang[^\n]*\n([\s\S]*?)(```|$)/g
/** A recursive walk covers parsed ASTs, evaluated element props and nested provider results. */
function nodes(value) {
  if (!value || !Predicate.isObjectOrArray(value)) return []
  return [value, ...Object.values(value).flatMap(nodes)]
}
function textOf(value) {
  if (Predicate.isString(value)) return value
  if (!value || !Predicate.isObjectOrArray(value)) return ''
  return Object.values(value).map(textOf).join('\n')
}
/** Element metadata is parser structure, not a value shown to the Person. */
function drawnText(value) {
  if (Predicate.isString(value)) return value
  if (!value || !Predicate.isObjectOrArray(value)) return ''
  if (value.type === 'element')
    return Object.entries(value.props)
      .filter(([key]) => key !== 'action')
      .map(([, prop]) => drawnText(prop))
      .join('\n')
  return Object.values(value).map(drawnText).join('\n')
}
/** Mutation receipts cannot legitimize their own invented values. They are checked against prior reads. */
function readEvidence(value) {
  if (Array.isArray(value)) return value.map(readEvidence)
  if (!value || !Predicate.isObjectOrArray(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['sent', 'created'].includes(key))
      .map(([key, item]) => [key, readEvidence(item)]),
  )
}

/** Choices need one shared state cell, selected bindings, and an answer carrying that cell. */
function wiring(result) {
  const elements = nodes(result.root).filter((node) => node.type === 'element')
  const tiles = elements.filter((node) => node.typeName === 'Pressable')
  if (tiles.length === 0) return { applicable: false, pass: true }
  const sets = tiles.flatMap((tile) =>
    nodes(tile.props.action).filter((node) => node.k === 'Comp' && node.name === 'Set'),
  )
  const variables = sets
    .flatMap((set) => set.args.slice(0, 1))
    .filter((node) => node.k === 'StateRef')
    .map((node) => node.n)
  const variable = variables[0]
  const selected = tiles.every((tile) =>
    nodes(tile.props.selected).some((node) => node.k === 'StateRef' && node.n === variable),
  )
  const answer = elements.some(
    (node) =>
      node.typeName === 'Button' &&
      nodes(node.props.action).some(
        (action) =>
          action.k === 'Comp' &&
          action.name === 'ToAssistant' &&
          nodes(action).some((ref) => ref.k === 'StateRef' && ref.n === variable),
      ),
  )
  return {
    applicable: true,
    tiles: tiles.length,
    variables: [...new Set(variables)],
    selected,
    answer,
    pass:
      tiles.length >= 2 &&
      variables.length === tiles.length &&
      new Set(variables).size === 1 &&
      selected &&
      answer,
  }
}

/** Evaluate initial drawing with the same store and library schema as the web renderer. */
function display(program, location, source, context) {
  try {
    const parsed = parser.parse(program)
    const errors = [...parsed.meta.errors]
    if (parsed.meta.incomplete) errors.push({ code: 'incomplete' })
    if (parsed.root === null) errors.push({ code: 'missing-root' })
    if (parsed.meta.unresolved.length)
      errors.push({ code: 'unresolved', values: parsed.meta.unresolved })
    const store = createStore()
    store.initialize(parsed.stateDeclarations, {})
    const ctx = { getState: (name) => store.get(name), resolveRef: () => null }
    const drawn = evaluateRoot(parsed, { ctx, library: { components: {} }, store })
    // Action messages and unselected choices can also contain invented people and times.
    const literals = nodes(parsed)
      .filter((node) => node.k === 'Str')
      .map((node) => node.v)
      .join('\n')
    return {
      location,
      errors,
      pass: errors.length === 0,
      wiring: wiring(parsed),
      visible: drawnText(drawn),
      provenance: [
        ...provenance(drawnText(drawn) + '\n' + literals, source, location, context),
        ...displayPeople(drawn, source, location, context),
      ],
    }
  } catch (error) {
    return {
      location,
      errors: [{ code: 'parser-or-evaluation', message: error.message }],
      pass: false,
      wiring: { applicable: false, pass: true },
      visible: '',
      provenance: provenance(program.replace(/\b\w+\(/g, ''), source, location, context),
    }
  }
}

/** Inspect nested results too, since run_code may return multiple provider responses. */
function tools(parts) {
  const calls = parts.filter((part) => part.type === 'dynamic-tool')
  return {
    calls: calls.length,
    inputValidation: calls
      .filter((call) => /Validation failed/i.test(call.errorText || ''))
      .map((call) => call.toolCallId),
    unknown: calls
      .filter(
        (call) =>
          !ToolName.literals.includes(call.toolName) ||
          /unknown tool|tool not found/i.test(JSON.stringify(call.output) + call.errorText),
      )
      .map((call) => call.toolName),
    refused: calls
      .filter(
        (call) =>
          call.state === 'output-error' || nodes(call.output).some((node) => node.ok === false),
      )
      .map((call) => ({ id: call.toolCallId, name: call.toolName })),
  }
}

/** Compare explicit claims with read-back effects, separately from private scenario expectations. */
function effectClaims(reply, effects) {
  const sentClaim =
    /\bi(?:['’]ve| have)?\s+(?:just\s+)?(?:sent|emailed|replied)\b|(?:^|\n)\s*(?:sent to|emailed|replied to)\b|\b(?:your|the) (?:email|reply|message) (?:has been|was|is) sent\b/i.test(
      reply,
    )
  const createdClaim =
    /\bi(?:['’]ve| have)?\s+(?:just\s+)?(?:booked|scheduled|created (?:the |an? )?(?:event|meeting))\b|(?:^|\n)\s*(?:booked|scheduled)\b/i.test(
      reply,
    )
  return {
    sentClaim,
    createdClaim,
    pass: (!sentClaim || effects.mail.length > 0) && (!createdClaim || effects.calendar.length > 0),
  }
}

/** The private file owns expected content. Reports keep check ids and outcomes, not its text. */
function expectations(checks, reply, effects, { connect, displays }) {
  return [
    ...checks.replyIncludes.map((pattern, index) => ({
      check: 'replyIncludes-' + index,
      pass: new RegExp(pattern, 'i').test(reply),
    })),
    ...checks.replyExcludes.map((pattern, index) => ({
      check: 'replyExcludes-' + index,
      pass: !new RegExp(pattern, 'i').test(reply),
    })),
    { check: 'mailSent', pass: effects.mail.length === checks.mailSent },
    { check: 'calendarCreated', pass: effects.calendar.length === checks.calendarCreated },
    { check: 'mailReadBack', pass: effects.readBack.every((item) => item.pass) },
    { check: 'connect', pass: checks.connect === connect.offered },
    {
      check: 'choice',
      pass: !checks.choice || displays.some((item) => item.wiring.applicable && item.wiring.pass),
    },
  ]
}

/** Ordered parts preserve which provider values existed before a drawing or mutation. */
function observePart(message, part, observed) {
  observed.position++
  if (part.type === 'dynamic-tool') {
    const outputNodes = nodes(part.output)
    const writes = outputNodes.flatMap((node) => [node.sent, node.created]).filter(Boolean)
    for (const record of writes)
      if (record.id) observed.writeSources.set(record.id, observed.source)
    if (outputNodes.some((node) => node.kind === 'connection-request' && node.ready === false))
      observed.connectAt = observed.position
    if (part.output !== undefined) observed.source += '\n' + textOf(readEvidence(part.output))
  }
  if (part.type !== 'text') return
  for (const [index, match] of Array.from(part.text.matchAll(fences)).entries()) {
    const location = message.id + '/part-' + observed.position + '/display-' + index
    const record = display(match[1], location, observed.source, observed.context)
    observed.displays.push({ ...record, position: observed.position })
    observed.provenanceChecks.push(...record.provenance)
  }
}

/** One submission is one reply, even when the model makes multiple tool steps inside it. */
function observeHistory(page, context) {
  const observed = {
    context,
    source: '',
    position: 0,
    displays: [],
    provenanceChecks: [],
    replies: new Map(),
    writeSources: new Map(),
    connectAt: null,
  }
  for (const message of page.messages) {
    if (message.role === 'user') observed.source += '\n' + textOf(message.parts)
    if (message.role !== 'assistant') continue
    const text = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    const reply = observed.replies.get(message.submissionId) || {
      submission: message.submissionId,
      characters: 0,
      displays: 0,
    }
    reply.characters += text.length
    reply.displays += Array.from(text.matchAll(fences)).length
    observed.replies.set(message.submissionId, reply)
    for (const part of message.parts) observePart(message, part, observed)
  }
  return observed
}

/** Shaped values use preceding Thread evidence. Closed recipient fields also use known world people. */
export function score(page, turns, effects, { checks, context }) {
  const { displays, provenanceChecks, replies, writeSources, connectAt } = observeHistory(
    page,
    context,
  )
  // Read-back is independent of the model's success receipt. The write's own return was stripped above.
  for (const [kind, records] of Object.entries({
    mail: effects.mail,
    calendar: effects.calendar,
  })) {
    for (const record of records) {
      const prior = writeSources.get(record.id)
      provenanceChecks.push(
        ...effectProvenance(kind, record, prior === undefined ? '' : prior, context),
      )
    }
  }
  const connect = {
    offered: connectAt !== null,
    position: connectAt,
    workBefore: displays.filter((item) => connectAt === null || item.position < connectAt).length,
  }
  connect.pass = !checks.connect || (connect.offered && connect.workBefore === 0)
  const reply = page.messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  const expected = expectations(checks, reply, effects, { connect, displays })
  const toolMetrics = tools(
    page.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.parts),
  )
  const claims = effectClaims(
    reply.replace(fences, '') + '\n' + displays.map((item) => item.visible).join('\n'),
    effects,
  )
  return {
    provenance: {
      checked: provenanceChecks.length,
      unsupported: provenanceChecks.filter((item) => !item.supported),
      pass: provenanceChecks.every((item) => item.supported),
    },
    display: {
      count: displays.length,
      replies: [...replies.values()],
      programs: displays.map(({ provenance: _provenance, visible: _visible, ...item }) => item),
      pass: displays.every((item) => item.pass),
    },
    wiring: {
      choices: displays.filter((item) => item.wiring.applicable).length,
      pass:
        displays.every((item) => item.wiring.pass) &&
        (!checks.choice || displays.some((item) => item.wiring.applicable)),
    },
    tools: {
      ...toolMetrics,
      replies: turns,
      pass:
        !toolMetrics.inputValidation.length &&
        !toolMetrics.unknown.length &&
        !toolMetrics.refused.length,
    },
    effects: {
      sent: effects.mail.length,
      created: effects.calendar.length,
      readBack: effects.readBack,
      claims,
      pass:
        claims.pass &&
        expected
          .filter((item) => ['mailSent', 'calendarCreated', 'mailReadBack'].includes(item.check))
          .every((item) => item.pass),
    },
    connect,
    expected,
    pass: expected.every((item) => item.pass),
  }
}
