import { Schema } from 'effect'

/** Read-only facts from a Computer's installed payload, never package names or executable paths. */
const ComputerApp = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
  purpose: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
})
type ComputerApp = typeof ComputerApp.Type

/** Absence of a running, verified Computer must never become an invented release inventory. */
export const ComputerInventory = Schema.TaggedUnion({
  Unavailable: {},
  Installed: { apps: Schema.Array(ComputerApp) },
})
export type ComputerInventory = typeof ComputerInventory.Type
