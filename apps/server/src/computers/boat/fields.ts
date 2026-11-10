import * as NodeCrypto from 'node:crypto'
import { HandoffFieldResult, type HandoffRefusalReason } from '@vivid/contracts'
import { Effect, Option, Redacted, Result } from 'effect'
import type { HandoffEntry, HandoffPageBinding, MachineFailure } from '../machine.ts'
import { binding, chrome, currentTab, Page, snapshot } from './browser.ts'
import type { Driver } from './driver.ts'
import { ActionReceipt } from './receipt.ts'
import { ComputerActionRefused, ComputerToolRefused } from './refusal.ts'

type Snapshot = typeof Page.Type
type Ref = Snapshot['refs'][number]

/** What a binding keeps of an address: its digest, so the address and its query are not kept. */
const addressDigest = (address: string) =>
  NodeCrypto.createHash('sha256').update(address).digest('hex')

/** Never start the browser for a handoff: its fields are on a page Vivid already has open. */
const noProxy = Effect.succeed(Option.none<string>())

/** The page's refs whose accessible name is this label, as `targetRef` in `browser.ts` matches. */
const named = (page: Snapshot, label: string): ReadonlyArray<Ref> =>
  page.refs.filter(
    (ref) => ref.name !== null && ref.name.toLocaleLowerCase() === label.toLocaleLowerCase(),
  )

/**
 * Whether one label names exactly one editable field. A label on something that cannot be typed
 * into is `UnsupportedField`; none, or two that could be typed into, is `TargetUnavailable`,
 * because typing a secret into a guess is worse than asking on the live screen.
 */
const fieldOf = (page: Snapshot, label: string): Result.Result<Ref, HandoffRefusalReason> => {
  const matches = named(page, label)
  const editable = matches.filter((ref) => ref.actions.includes('type'))
  const field = editable[0]
  if (editable.length === 1 && field !== undefined) return Result.succeed(field)
  return Result.fail(
    editable.length === 0 && matches.length > 0 ? 'UnsupportedField' : 'TargetUnavailable',
  )
}

/**
 * Whether a typing receipt says the driver is unsure what reached the field. `partial` and
 * `suspected_noop` are Cua's own doubt about the effect (`action_record.rs` public_result); a
 * receipt otherwise reports delivery only (`receipt.ts`).
 */
const uncertain = (receipt: typeof ActionReceipt.Type) =>
  receipt.effect === 'partial' || receipt.effect === 'suspected_noop'

/** A refusal the driver states: it did nothing, as opposed to an answer that was lost. */
const isRefusal = (failure: MachineFailure) =>
  failure instanceof ComputerToolRefused || failure instanceof ComputerActionRefused

/** A fresh snapshot of one tab the driver already knows, by the ids it minted for it. */
const snapshotOf = (native: Driver, target: string, tab: string) =>
  native.call(
    'get_browser_state',
    { target_id: target, tab_id: tab, snapshot_format: 'semantic_v2' },
    Page,
  )

/**
 * A fresh snapshot of the prepared tab, when it still shows the prepared address; none when the
 * address moved on, which is refused as changed.
 *
 * It reads the capability Prepare was given and never binds again: Cua 0.23.2 mints a new
 * `target_id` and new `tab_id`s on every bind (`browser/engine.rs` bind, `store.mint_target` and
 * `mint_tab_id`), so comparing a fresh bind's ids with the prepared ones refused every fill. The
 * prepared ids stay live in the driver's session store (`browser/store.rs` keeps every minted
 * target) and name one CDP page target, so a snapshot by them reads that same tab whichever tab
 * is current. The driver re-proves the whole binding chain before it types (`engine.rs`
 * `revalidate_for_mutation`) and refuses a ref whose document navigated since its snapshot
 * (`frame_session_for_mutation`, `browser_ref_stale`). Its public snapshot names the document by
 * address only (`tools.rs` snapshot `page.url` is the document's `documentURL`); its loader id is
 * private, so a reload of the same address cannot be told apart here.
 */
const boundPage = Effect.fn('Machine.boat.fields.bound')(function* (
  native: Driver,
  page: HandoffPageBinding,
) {
  const now = yield* snapshotOf(native, page.target, page.tab)
  return addressDigest(now.page.url) === page.digest ? Option.some(now) : Option.none<Snapshot>()
})

/** Preflight: the page the browser shows now and, for each label, whether it can be filled. */
export const findFields = Effect.fn('Machine.boat.fields.find')(function* (
  native: Driver,
  labels: ReadonlyArray<string>,
) {
  const window = yield* chrome(native, false, noProxy)
  const bound = yield* binding(native, window)
  const tab = yield* currentTab(bound)
  const page = yield* snapshot(native, bound)
  return {
    page: { target: bound.target_id, tab: tab.tab_id, digest: addressDigest(page.page.url) },
    address: page.page.url,
    fields: labels.map((label) => Result.getFailure(fieldOf(page, label))),
  }
})

/**
 * Types one value. The page is read again just before, so a navigation between two fields
 * refuses the rest rather than typing a password into whatever page came next. A refusal the
 * driver states is definite (nothing typed); a lost answer, or a receipt in which the driver
 * doubts its own effect, may have typed part of it, so it is unknown. The value is unwrapped only into the driver's private input file (`driver.ts` `input`).
 */
const fillOne = Effect.fn('Machine.boat.fields.fillOne')(function* (
  native: Driver,
  page: HandoffPageBinding,
  entry: HandoffEntry,
): Effect.fn.Return<HandoffFieldResult> {
  // A page that cannot be read now has had nothing typed into it: refused, not unknown.
  const now = yield* boundPage(native, page).pipe(
    Effect.asSome,
    Effect.orElseSucceed(() => Option.none<Option.Option<Snapshot>>()),
  )
  if (Option.isNone(now))
    return HandoffFieldResult.cases.Refused.make({ reason: 'TargetUnavailable' })
  if (Option.isNone(now.value))
    return HandoffFieldResult.cases.Refused.make({ reason: 'TargetChanged' })
  const field = fieldOf(now.value.value, entry.label)
  if (Result.isFailure(field))
    return HandoffFieldResult.cases.Refused.make({ reason: field.failure })
  return yield* native
    .call(
      'browser_type',
      {
        target_id: page.target,
        tab_id: page.tab,
        ref: field.success.ref,
        text: Redacted.value(entry.value),
        replace: true,
      },
      ActionReceipt,
    )
    .pipe(
      Effect.map((receipt): HandoffFieldResult =>
        uncertain(receipt)
          ? HandoffFieldResult.cases.OutcomeUnknown.make({})
          : HandoffFieldResult.cases.Filled.make({}),
      ),
      Effect.catch((failure) =>
        Effect.succeed(
          isRefusal(failure)
            ? HandoffFieldResult.cases.Refused.make({ reason: 'UnsupportedField' })
            : HandoffFieldResult.cases.OutcomeUnknown.make({}),
        ),
      ),
    )
})

/** Every entry gets its own result, in order; one field's failure never hides another's. */
export const fillFields = Effect.fn('Machine.boat.fields.fill')(function* (
  native: Driver,
  page: HandoffPageBinding,
  entries: ReadonlyArray<HandoffEntry>,
): Effect.fn.Return<ReadonlyArray<HandoffFieldResult>, MachineFailure> {
  return yield* Effect.forEach(entries, (entry) => fillOne(native, page, entry))
})

/** One tab the driver knows by ids it minted, where typed values may still be. */
interface Tab {
  readonly target: string
  readonly tab: string
}

/**
 * The tabs that may still show what was typed. While the driver still knows the prepared ids,
 * that is the prepared tab if it still shows the prepared address, and none once it moved on: a
 * new document does not hold the old one's values. When the driver refuses those ids (a new
 * driver session after a server restart, or the tab was closed), the browser is bound again and
 * every tab at the prepared address is one to empty. Emptying is not typing a secret, so a fresh
 * bind's ids are fine here; anything that cannot be read fails, and nothing is proven.
 */
const holding = Effect.fn('Machine.boat.fields.holding')(function* (
  native: Driver,
  page: HandoffPageBinding,
) {
  const prepared = yield* snapshotOf(native, page.target, page.tab).pipe(
    Effect.asSome,
    Effect.catchIf(
      (failure) => failure instanceof ComputerToolRefused,
      () => Effect.succeedNone,
    ),
  )
  if (Option.isSome(prepared))
    return addressDigest(prepared.value.page.url) === page.digest
      ? [{ target: page.target, tab: page.tab }]
      : []
  const bound = yield* binding(native, yield* chrome(native, false, noProxy))
  return bound.tabs
    .filter((tab) => addressDigest(tab.url) === page.digest)
    .map((tab): Tab => ({ target: bound.target_id, tab: tab.tab_id }))
})

/** Whether a field reads back empty: the AX value of an emptied input is absent or blank. */
const isEmpty = (page: Snapshot, label: string) => {
  const field = fieldOf(page, label)
  return Result.isSuccess(field) && (field.success.value === null || field.success.value === '')
}

/**
 * Whether one label's field on one tab is proven to hold nothing: the tab moved to another
 * address, or the field was emptied and reads back empty with a receipt the driver does not
 * doubt. It is always typed over, never judged by its value first, because a password field's
 * accessible value is not something to trust as the whole truth. A label that does not name
 * exactly one field is not proven: the control may be hidden with its value still in it.
 */
const emptied = Effect.fn('Machine.boat.fields.emptied')(function* (
  native: Driver,
  at: Tab,
  digest: string,
  label: string,
) {
  const before = yield* snapshotOf(native, at.target, at.tab)
  if (addressDigest(before.page.url) !== digest) return true
  const field = fieldOf(before, label)
  if (Result.isFailure(field)) return false
  const receipt = yield* native.call(
    'browser_type',
    { target_id: at.target, tab_id: at.tab, ref: field.success.ref, text: '', replace: true },
    ActionReceipt,
  )
  if (uncertain(receipt)) return false
  const after = yield* snapshotOf(native, at.target, at.tab)
  return addressDigest(after.page.url) !== digest || isEmpty(after, label)
})

/**
 * Empties the handoff's fields wherever they may still be, and answers the labels it could not
 * prove empty. Only an empty answer lets the handoff release the Computer (`inputs/handoff.ts`);
 * a refusal the driver states for one field leaves that label among them, while a failure that
 * says nothing (a lost answer) fails the whole clearing.
 */
export const clearFields = Effect.fn('Machine.boat.fields.clear')(function* (
  native: Driver,
  page: HandoffPageBinding,
  labels: ReadonlyArray<string>,
): Effect.fn.Return<ReadonlyArray<string>, MachineFailure> {
  const tabs = yield* holding(native, page)
  /** One label, emptied on every tab that may hold it, or itself when one is not proven. */
  const left = (label: string) =>
    Effect.forEach(tabs, (at) =>
      emptied(native, at, page.digest, label).pipe(
        Effect.catchIf(isRefusal, () => Effect.succeed(false)),
      ),
    ).pipe(Effect.map((done) => (done.every(Boolean) ? [] : [label])))
  return (yield* Effect.forEach(labels, left)).flat()
})
