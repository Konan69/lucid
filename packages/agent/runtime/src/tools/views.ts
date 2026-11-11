import * as Arr from 'effect/Array'
import {
  AnotherAccountMessage,
  type BrowseResult,
  type DesktopView,
  type ConnectionOffer,
  type FindToolsResponse,
  type Service,
  type InputRequest,
  type HandoffKind,
  PrepareHandoffOutcome,
  type LibrarySearchResult,
  type Skill,
  type SkillSummary,
} from '@vivid/contracts'
import { Schema } from 'effect'
import { SavedProcedures, type ContextSkill } from './snapshots.ts'
import { catalog, savedInventory } from './names.ts'

const isAnotherAccount = Schema.is(AnotherAccountMessage)

/** Saved context and read resolution share naming; native built-ins never enter this inventory. */
export function skills(items: readonly ContextSkill[]): SavedProcedures {
  if (items.length === 0)
    return SavedProcedures.cases.Unavailable.make({
      message: 'Saved procedures are unavailable right now; continue with the built-in skills.',
    })
  return SavedProcedures.cases.Available.make({
    skills: savedInventory(items, (item) => modelText(item.name)).map(({ item, name }) =>
      skillSummary(item, name),
    ),
  })
}

/** Saving and context views share the same internal runtime procedure summary. */
export function skillSummary(item: SkillSummary, name: string) {
  return { name: modelText(name), useWhen: modelText(item.useWhen) }
}

/** Reading a saved procedure exposes its instructions and runtime name, never storage identity. */
export function skill(item: Skill, name: string) {
  return {
    name: modelText(name),
    useWhen: modelText(item.useWhen),
    instructions: modelText(item.instructions),
    source: 'Saved procedure',
  }
}

/**
 * The server resolves an account by its original label, never by a `modelText` alias. An account
 * whose label would be rewritten (it holds a reference the model must not see) cannot be shown as
 * written and cannot be called by a rewritten name, so its tools are left out. They are counted in
 * `withheld`, so the model knows something exists that it cannot reach and can say so, instead of
 * concluding the Integration has no such tool.
 */
export function tools(response: FindToolsResponse) {
  const sayable = response.tools.filter((item) => modelText(item.account) === item.account)
  return {
    tools: sayable.map((item) => ({
      account: item.account,
      tool: item.name,
      description: modelText(item.description),
      effect: item.effect,
      call: item.call,
      signature: item.signature,
    })),
    withheld: response.tools.length - sayable.length,
    unconnected: catalog(response.unconnected, (item) => modelText(item.name)).map(
      ({ item, name }) => ({
        service: name,
        description: modelText(item.description),
      }),
    ),
  }
}

/** Citations are source filenames and page numbers rather than storage references. */
export function passages(items: readonly (typeof LibrarySearchResult.Type)[]) {
  return items.map((item) => ({
    filename: modelText(item.filename),
    page: item.page,
    text: modelText(item.text),
    citation:
      item.page === null
        ? `[${modelText(item.filename)}]`
        : `[${modelText(item.filename)}, p.${item.page}]`,
  }))
}

/** Browser addresses can contain authority or image URLs; only the readable page is shown. */
export function browse(item: BrowseResult) {
  return {
    address: modelText(item.address),
    title: modelText(item.title),
    outline: modelText(
      item.outline.replace(/\[e[a-fA-F0-9]+\.[a-fA-F0-9]+:\d+\]/g, '').replace(/\[p\d+:\d+\]/g, ''),
    ),
    truncated: item.truncated,
    tabs: item.tabs.map((tab) => ({
      title: modelText(tab.title),
      address: modelText(tab.address),
      showing: tab.showing,
    })),
  }
}

/** Coordinates and the focused title accompany actual image content; provider and Vivid identities stay out. */
export function desktop(item: DesktopView) {
  return {
    width: item.width,
    height: item.height,
    pointer: item.pointer,
    window: item.window === null ? null : modelText(item.window),
  }
}

/** Card references keep the exact fields web and phone clients need to draw and answer them. */
export function inputRequest(item: InputRequest) {
  return {
    kind: 'input-request',
    requestId: item.id,
    questions: Arr.map(item.questions, (question) => modelText(question.question)),
    message:
      'Asked. Their answer will arrive as a new message; keep working on what does not depend on it.',
  }
}

/**
 * What Vivid reads back when it hands a step over. A prepared one is a card reference, like a
 * question; every refusal says what to do next. Nothing here names a value: none exists yet.
 */
export function handoff(outcome: PrepareHandoffOutcome): Schema.Json {
  return PrepareHandoffOutcome.match<Schema.Json>(outcome, {
    Prepared: (prepared) => ({
      kind: 'handoff',
      handoffId: prepared.handoff.id,
      message:
        'Handed to the person. Your computer is theirs until they finish; you will be told when they do.',
    }),
    FieldsRefused: ({ fields }) => ({
      ok: false,
      fields: fields.map((field) => ({ label: modelText(field.label), reason: field.reason })),
      message:
        'These fields are not on the page as one field each that can be typed into. Read the page again, or hand the step over on the screen with no fields.',
    }),
    RunRequired: () => ({
      ok: false,
      message: 'A step is handed over only while you are working.',
    }),
    Busy: () => ({
      ok: false,
      message: 'Another step is already waiting on the person on your computer. Wait for it.',
    }),
    Unavailable: ({ reason }) => ({ ok: false, message: modelText(reason) }),
  })
}

/** A form for a step that has nothing to type into, refused before the server is asked. */
export function handoffWithoutFields(kind: HandoffKind) {
  return {
    ok: false,
    message: `A ${kind} step is done on the screen: hand it over again with no fields.`,
  }
}

/**
 * See inputRequest: the catalog reference is required by the existing connection card contract.
 * A request for one more account also carries when Vivid asked (`AnotherAccountMessage`): the
 * card needs it to tell the account that was asked for from the ones the Person already had.
 */
export function connectionRequest(item: ConnectionOffer) {
  const card = {
    kind: item.kind,
    service: item.service,
    serviceName: modelText(item.serviceName),
    reason: modelText(item.reason),
    ready: item.ready,
  }
  if (isAnotherAccount(item)) return { ...card, another: item.another }
  return card
}

/**
 * The service is connected and Vivid did not ask for one more account, so there is no card to
 * show. The words say what to do next either way: use an account that is there, or ask again for
 * another one.
 */
export function alreadyConnected(service: Service) {
  const name = modelText(service.name)
  return {
    connected: true,
    message: `${name} is already connected. Call find_tools to see its accounts and use the one the person means. If they need an account that is not among them, call connect again with another set to true.`,
  }
}

/** See inputRequest: approvalId is required by existing clients and cannot be hidden through defineTool. */
export function approval(item: { readonly approvalId: string; readonly summary: string }) {
  return {
    kind: 'approval-request',
    approvalId: item.approvalId,
    summary: modelText(item.summary),
    message: 'Stop and wait; the person has been asked to approve this action.',
  }
}

/**
 * Every refusal speaks twice. `message` is for Vivid, in the system's words: what went wrong and
 * what to do next. `tell_them` is what the same fact means for the Person, already in their words
 * ("i can't get into your agency notion yet. sign in again and pick mirabel's workspace."), so
 * the reply never has to paraphrase a status, a setting or an error name. Both are required: a
 * refusal written for only one reader is how "the connection never finished authorizing, so it
 * loads zero tools" reached a Person (production, 11 November 2026). When nothing about the
 * refusal is the Person's business (a malformed call Vivid fixes itself), `tell_them` says so and
 * the voice rule keeps it out of the reply.
 */
export function refused(message: string, tellThem: Plain) {
  return { ok: false, message: modelText(message), tell_them: modelText(tellThem.text) }
}

/**
 * A sentence for the Person, distinct from a sentence for Vivid at the type level so a refusal
 * cannot pass its system message twice. `quiet` marks a refusal the Person never hears about.
 */
export interface Plain {
  readonly text: string
}
export const plain = (text: string): Plain => ({ text })
export const quiet: Plain = plain('Nothing to tell them; fix the call and carry on.')
/** For a refusal whose message is worded elsewhere (the server's InvalidRequest, a provider's
 * reason), so its meaning for the Person cannot be written here. */
export const translate: Plain = plain(
  'If this stops what they asked for, tell them in their own words what did not happen and the one thing that would fix it.',
)

/** Vivid text omits opaque references and image URLs; email addresses remain usable contact data. */
export function modelText(value: string) {
  // Match addresses before references: even a UUID-shaped mailbox remains a usable address.
  return value.replaceAll(
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|https?:\/\/[^\s"<>]+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^\s"<>]*)?/giu,
    (match) => {
      if (match.includes('@')) return match
      return match.toLowerCase().startsWith('http') ? '[image]' : '[reference]'
    },
  )
}
