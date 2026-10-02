import { Array as Arr, Result, Schema } from 'effect'

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
export function distinct(labels: readonly string[]): readonly string[] {
  const reserved = new Set(labels.map(folded))
  const used = new Set<string>()
  return labels.map((label) => {
    const base = label.trim()
    let name = base
    let occurrence = 2
    if (used.has(folded(name))) {
      do {
        name = `${base} (${occurrence++})`
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

/** Both view and resolver use the full inventory before filtering or bounding its displayed rows. */
export function inventory<A>(items: readonly A[], label: (item: A) => string) {
  const names = distinct(items.map(label))
  return Arr.zip(items, names).map(([item, name]) => ({ item, name }))
}
