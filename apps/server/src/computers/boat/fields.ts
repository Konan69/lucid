import * as NodeCrypto from 'node:crypto'
import { HandoffFieldResult, type HandoffRefusalReason } from '@vivid/contracts'
import { Effect, Option, Redacted } from 'effect'
import type { HandoffEntry, HandoffPageBinding, MachineFailure } from '../machine.ts'
import { binding, chrome, currentTab, snapshot, type Page } from './browser.ts'
import type { Driver } from './driver.ts'
import { ActionReceipt } from './receipt.ts'
import { ComputerActionRefused, ComputerToolRefused } from './refusal.ts'

type Snapshot = typeof Page.Type
type Ref = Snapshot['refs'][number]

/** What a binding keeps of an address: its digest, so the address and its query are not kept. */
export const addressDigest = (address: string) =>
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
const fieldOf = (page: Snapshot, label: string) => {
  const matches = named(page, label)
  const editable = matches.filter((ref) => ref.actions.includes('type'))
  const field = editable[0]
  if (editable.length === 1 && field !== undefined) return { _tag: 'Found', ref: field.ref } as const
  const reason: HandoffRefusalReason =
    editable.length === 0 && matches.length > 0 ? 'UnsupportedField' : 'TargetUnavailable'
  return { _tag: 'Refused', reason } as const
}

/**
 * The browser's current tab and a fresh snapshot of it, when it is still the bound page: the same
 * window, the same tab and the same address. Anything else is none, and is refused as changed.
 */
const boundPage = Effect.fn('Machine.boat.fields.bound')(function* (
  native: Driver,
  page: HandoffPageBinding,
) {
  const window = yield* chrome(native, false, noProxy)
  const bound = yield* binding(native, window)
  const tab = yield* currentTab(bound)
  if (bound.target_id !== page.target || tab.tab_id !== page.tab) return Option.none<Snapshot>()
  const now = yield* snapshot(native, bound)
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
    fields: labels.map((label) => {
      const field = fieldOf(page, label)
      return field._tag === 'Found' ? Option.none() : Option.some(field.reason)
    }),
  }
})

/**
 * Types one value. The page is read again just before, so a navigation between two fields
 * refuses the rest rather than typing a password into whatever page came next. A refusal the
 * driver states is definite (nothing typed); a lost answer may have typed, so it is unknown.
 * The value is unwrapped only into the driver's private input file (`driver.ts` `input`).
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
  if (field._tag === 'Refused') return HandoffFieldResult.cases.Refused.make({ reason: field.reason })
  return yield* native
    .call(
      'browser_type',
      {
        target_id: page.target,
        tab_id: page.tab,
        ref: field.ref,
        text: Redacted.value(entry.value),
        replace: true,
      },
      ActionReceipt,
    )
    .pipe(
      Effect.as<HandoffFieldResult>(HandoffFieldResult.cases.Filled.make({})),
      Effect.catch((failure) =>
        Effect.succeed(
          failure instanceof ComputerToolRefused || failure instanceof ComputerActionRefused
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

/**
 * Empties each field still on the bound page. A page that moved on (the Person signed in, or left)
 * holds none of the typed values any more, so there is nothing to clear.
 */
export const clearFields = Effect.fn('Machine.boat.fields.clear')(function* (
  native: Driver,
  page: HandoffPageBinding,
  labels: ReadonlyArray<string>,
): Effect.fn.Return<void, MachineFailure> {
  for (const label of labels) {
    const now = yield* boundPage(native, page)
    if (Option.isNone(now)) return
    const field = fieldOf(now.value, label)
    if (field._tag === 'Refused') continue
    yield* native.call(
      'browser_type',
      { target_id: page.target, tab_id: page.tab, ref: field.ref, text: '', replace: true },
      ActionReceipt,
    )
  }
})
