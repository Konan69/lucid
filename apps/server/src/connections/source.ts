import { Schema } from 'effect'

/** Hosted CustomAppInput in packages/catalog/src/contracts/imports.ts accepts MCP only.
 * Recognition of an OpenAPI document is a supported probe result but an unsupported import;
 * do not misreport it as a malformed URL, missing credentials, or a tool policy refusal.
 */
export class ExecutorSourceUnsupported extends Schema.TaggedError<ExecutorSourceUnsupported>()(
  'ExecutorSourceUnsupported',
  { source: Schema.Literal('OpenApi') },
  { title: 'Integration source unsupported' },
) {}
