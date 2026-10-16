import * as Arr from 'effect/Array'
import {
  AnotherAccountMessage,
  MemoryScope,
  type BrowseResult,
  type DesktopView,
  type ConnectionOffer,
  type FindToolsResponse,
  type Service,
  type InputRequest,
  type LibrarySearchResult,
  type Memory,
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

/** Scope and provenance are human concepts; Thread scope already carries its accessible title. */
export function memories(items: readonly Memory[]) {
  return items.map((item) => ({
    kind: item.kind,
    content: modelText(item.content),
    about: MemoryScope.match(item.scope, {
      Person: () => 'this Person',
      Company: () => 'the whole Company',
      Thread: ({ title }) => `the Thread “${modelText(title)}”`,
    }),
    learnedFrom: modelText(item.learnedFrom.name),
  }))
}

/** A saved fact needs confirmation, not a reference the model can mutate later. */
export function remembered(item: Memory) {
  return { ok: true, remembered: modelText(item.content) }
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

/** Flue 2.1 custom tools stringify the same output stored in client history (conversation-stream-store).
 * These three card references are the sole exception: defineTool has no separate content/details API.
 * Web/mobile require these exact fields to render and answer the server-owned card. */
export function inputRequest(item: InputRequest) {
  return {
    kind: 'input-request',
    requestId: item.id,
    questions: Arr.map(item.questions, (question) => modelText(question.question)),
    message: 'End the turn now; the person has been asked and their answer will return here.',
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
