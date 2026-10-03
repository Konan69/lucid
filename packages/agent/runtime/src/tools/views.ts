import {
  MemoryScope,
  RoutineTrigger,
  type BrowseResult,
  type CommandResult,
  type DesktopView,
  type ConnectionRequestMessage,
  type FindToolsResponse,
  type InputRequest,
  type LibrarySearchResult,
  type Memory,
  type Routine,
  type Skill,
  type SkillSummary,
} from '@vivid/contracts'
import { SavedProcedures, type ContextSkill } from './snapshots.ts'
import { catalog, distinct, inventory, savedInventory } from './names.ts'

/** Dates cross the model boundary in ISO units; null remains genuine domain absence. */
const date = (value: number | null) => (value === null ? null : new Date(value).toISOString())

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

/** Discovery exposes usable account names and callable signatures, without catalog or Connection references. */
export function tools(response: FindToolsResponse) {
  return {
    tools: response.tools.map((item) => ({
      account: modelText(item.account),
      tool: item.name,
      description: modelText(item.description),
      effect: item.effect,
      call: item.call,
      signature: item.signature,
    })),
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

/** Ambiguity exposes distinct statement names, never references, rankings or a selected target. */
export function memoryChoices(items: readonly Memory[]) {
  return {
    ok: false,
    matches: distinct(items.map((item) => modelText(item.content))),
    message:
      items.length === 0
        ? 'No matching memory was found.'
        : 'No unique exact match was found. Choose one of these memories; nothing has changed.',
  }
}

/** A successful forgetting confirms only the words removed, after the RPC completed. */
export function forgotten(item: Memory) {
  return { ok: true, forgot: modelText(item.content) }
}

/** Version identities stay inside the tool; the model reports the before and after wording. */
export function corrected(was: Memory, now: Memory) {
  return { ok: true, corrected: { was: modelText(was.content), now: modelText(now.content) } }
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

/** Execution receipts and folder scope belong to the server, not the model's Routine catalog. */
export function routine(item: Routine, name: string) {
  return {
    name: modelText(name),
    prompt: modelText(item.prompt),
    schedule: RoutineTrigger.match<{ cron: string; timezone: string } | string>(item.trigger, {
      Once: ({ at, timezone }) =>
        `once on ${new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(at)} · ${timezone}`,
      Schedule: ({ cron, timezone }) => ({ cron, timezone }),
      Webhook: () => 'when called',
      Integration: ({ account, event }) => `when ${event} happens in ${account}`,
    }),
    enabled: item.enabled,
    nextRunAt: date(item.nextRunAt),
  }
}

/** Routine names use creation order, so later edits never change duplicate suffixes. */
export function routines(items: readonly Routine[]) {
  return inventory(items, (item) => modelText(item.name)).map(({ item, name }) =>
    routine(item, name),
  )
}

/** Computer output has no machine/session references; opaque output is filtered at this adapter. */
export function command(item: CommandResult) {
  return { exitCode: item.exitCode, output: modelText(item.output), truncated: item.truncated }
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
    question: modelText(item.question),
    message: 'End the turn now; the person has been asked and their answer will return here.',
  }
}

/** See inputRequest: the catalog reference is required by the existing connection card contract. */
export function connectionRequest(item: ConnectionRequestMessage) {
  return {
    kind: item.kind,
    service: item.service,
    serviceName: modelText(item.serviceName),
    reason: modelText(item.reason),
    ready: item.ready,
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
