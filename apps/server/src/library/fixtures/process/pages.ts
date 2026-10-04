import * as Schema from 'effect/Schema'

/** One stdout wire codec keeps the CLI fixture's encoded pages and E8's ingress in agreement. */
export const Pages = Schema.fromJsonString(Schema.Array(Schema.String))
