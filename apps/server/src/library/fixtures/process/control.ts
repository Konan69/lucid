import * as Schema from 'effect/Schema'

/** Fixture IPC stays separate from stdout, whose complete contents must remain decoded pages. */
export const Ready = Schema.TaggedStruct('Ready', {})
export const Extract = Schema.TaggedStruct('Extract', {})

/** A missing control channel or an early native end cannot establish extraction readiness. */
export class CommandUnavailable extends Schema.TaggedError<CommandUnavailable>()(
  'ExtractionCommandUnavailable',
  {},
) {}
