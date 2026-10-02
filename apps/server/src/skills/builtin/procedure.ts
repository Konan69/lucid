import { Schema } from 'effect'

/** Tool prerequisites are checked against runtime registration in the catalogue suite.
 * Each Connection group accepts any listed service; all groups must be ready for an offer. */
export const Procedure = Schema.Struct({
  starter: Schema.Boolean,
  name: Schema.String,
  useWhen: Schema.String,
  about: Schema.String,
  needs: Schema.Array(Schema.String),
  connections: Schema.Array(Schema.Array(Schema.String)),
  instructions: Schema.String,
})
export interface Procedure extends Schema.Schema.Type<typeof Procedure> {}
