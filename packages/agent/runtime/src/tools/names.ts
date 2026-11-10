import { Array as Arr, Order, Option, Result, Schema } from 'effect'
import { builtinNamed, isBuiltin } from '@vivid/skills'
import { type SkillId } from '@vivid/contracts'

export class NameMissing extends Schema.TaggedError<NameMissing>()(
  'NameMissing',
  {
    name: Schema.String,
  },
  { title: 'No matching name' },
) {}
export class NameAmbiguous extends Schema.TaggedError<NameAmbiguous>()(
  'NameAmbiguous',
  {
    name: Schema.String,
    matches: Schema.Array(Schema.String),
  },
  { title: 'Ambiguous name' },
) {}

/** Names compare exactly apart from whitespace and case, never by fuzzy similarity. */
const folded = (label: string) => label.trim().toLowerCase()

/** Reserve original labels too, so a literal “Draft (2)” cannot collide with a generated suffix. */
function distinct(labels: readonly string[]): readonly string[] {
  const reserved = new Set(labels.map(folded))
  const used = new Set<string>()
  return labels.map((label) => {
    const base = label.trim()
    let name = base
    let suffix = 2
    if (used.has(folded(name))) {
      do {
        name = `${base} (${suffix++})`
      } while (reserved.has(folded(name)) || used.has(folded(name)))
    }
    used.add(folded(name))
    return name
  })
}

/** Resolve only the same named inventory the view exposed; ambiguity never picks the first record. */
export function named<A>(
  list: readonly { readonly name: string; readonly item: A }[],
  name: string,
): Result.Result<A, NameMissing | NameAmbiguous> {
  const matches = list.filter((entry) => folded(entry.name) === folded(name))
  const [match] = matches
  if (matches.length === 0) return Result.fail(new NameMissing({ name: name.trim() }))
  if (matches.length === 1 && match !== undefined) return Result.succeed(match.item)
  return Result.fail(
    new NameAmbiguous({ name: name.trim(), matches: matches.map((entry) => entry.name) }),
  )
}

/** Number an already ordered inventory, reserving every literal label before assigning suffixes. */
function numbered<A>(items: readonly A[], label: (item: A) => string) {
  const names = distinct(items.map(label))
  return Arr.zip(items, names).map(([item, name]) => ({ item, name }))
}

/** Provider catalogs have no creation time; their immutable service key fixes duplicate naming. */
export function catalog<A extends { readonly id: string }>(
  items: readonly A[],
  label: (item: A) => string,
) {
  return numbered(
    Arr.sortWith(items, (item) => item.id, Order.String),
    label,
  )
}

/** Historical saved display names project to lowercase runtime labels. An old collision remains
 * readable under a saved suffix, never under a built-in's permanently reserved runtime name.
 * Preserve legacy punctuation and non-Latin text: these RPC labels are not native folder names. */
function savedName(label: string) {
  const runtime = label.trim().toLowerCase().replace(/\s+/gu, '-')
  return Option.isSome(builtinNamed(runtime)) ? `${runtime}-saved` : runtime
}

/** Reserve literal runtime labels before numbering duplicates, including generated -2 labels.
 * This order matches reads and saves and prevents a legacy display name from shadowing a native skill. */
function distinctSaved(labels: readonly string[]) {
  const bases = labels.map(savedName)
  const reserved = new Set(bases)
  const used = new Set<string>()
  return bases.map((base) => {
    let name = base
    let suffix = 2
    if (used.has(name)) {
      do {
        name = `${base}-${suffix++}`
      } while (reserved.has(name) || used.has(name))
    }
    used.add(name)
    return name
  })
}

/** Built-in handles never enter saved context; ordering and runtime labels are shared by read/save. */
export function savedInventory<A extends { readonly createdAt: number; readonly id: SkillId }>(
  items: readonly A[],
  label: (item: A) => string,
) {
  const saved = Arr.sort(
    items.filter((item) => !isBuiltin(item.id)),
    Order.combine(
      Order.mapInput(Order.Number, (item: A) => item.createdAt),
      Order.mapInput(Order.String, (item: A) => item.id),
    ),
  )
  return Arr.zip(saved, distinctSaved(saved.map(label))).map(([item, name]) => ({ item, name }))
}
